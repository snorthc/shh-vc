/**
 * Shh VC token service.
 *
 * Its whole job: turn a room id into a LiveKit join token. It must never see
 * the room secret, a display name, or any media key, and it writes nothing to
 * disk. If this service is compromised, an attacker can join rooms whose ids
 * they already know — and still cannot decrypt anything, because keys are
 * agreed between browsers under a secret derived from the link.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { loadConfig } from './config.ts';
import { clientKey, RateLimiter } from './ratelimit.ts';
import { attachSignalRelay } from './signal.ts';
import { RoomRegistry } from './rooms.ts';

const config = loadConfig();
const limiter = new RateLimiter(config.rateLimit, config.rateWindowMs);
const rooms = new RoomServiceClient(
  config.livekitHostUrl,
  config.livekitApiKey,
  config.livekitApiSecret,
);

const registry = new RoomRegistry();

/** Aggregate counters only. Deliberately nothing per-client. */
const stats = { tokens: 0, rejected: 0, rateLimited: 0, full: 0, moderation: 0 };

/** Room ids are 32 base64url chars: SHA-256 of the room secret, truncated. */
const ROOM_ID = /^[A-Za-z0-9_-]{32}$/;
/** Participant identities are 22 base64url chars: 16 random bytes. */
const IDENTITY = /^[A-Za-z0-9_-]{16,43}$/;

const MAX_BODY_BYTES = 4096;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (config.allowedOrigins.length === 0) return true;
  if (!origin) return true;
  if (!config.allowedOrigins.includes(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  return true;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function countRooms(): Promise<number> {
  try {
    return (await rooms.listRooms()).length;
  } catch {
    // If we cannot ask LiveKit, do not use that as an excuse to allow
    // unbounded room creation.
    return Number.POSITIVE_INFINITY;
  }
}

async function roomIsFull(roomId: string): Promise<boolean> {
  try {
    const [room] = await rooms.listRooms([roomId]);
    if (!room) return false;
    return room.numParticipants >= config.maxParticipants;
  } catch {
    return false;
  }
}

async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = clientKey(req.socket.remoteAddress);
  if (!limiter.check(key)) {
    stats.rateLimited++;
    send(res, 429, { error: 'too many requests' });
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    stats.rejected++;
    send(res, 400, { error: 'bad request body' });
    return;
  }

  const { roomId, identity, hostKey } = (body ?? {}) as Record<string, unknown>;
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) {
    stats.rejected++;
    send(res, 400, { error: 'invalid room id' });
    return;
  }
  if (typeof identity !== 'string' || !IDENTITY.test(identity)) {
    stats.rejected++;
    send(res, 400, { error: 'invalid identity' });
    return;
  }

  if (hostKey !== undefined && !RoomRegistry.validHostKey(hostKey)) {
    stats.rejected++;
    send(res, 400, { error: 'invalid host key' });
    return;
  }

  if (await roomIsFull(roomId)) {
    stats.full++;
    send(res, 409, { error: 'room is full', maxParticipants: config.maxParticipants });
    return;
  }

  let isHost = false;
  try {
    const existing = (await rooms.listRooms([roomId])).length > 0;
    if (RoomRegistry.validHostKey(hostKey)) {
      isHost = registry.claimOrVerifyHost(roomId, hostKey, !existing);
    }
    if (registry.get(roomId)?.locked && !isHost && !registry.isAdmitted(roomId, identity)) {
      send(res, 423, { error: 'this room is locked by its host' });
      return;
    }
    if (!existing && (await countRooms()) >= config.maxConcurrentRooms) {
      send(res, 503, { error: 'server at capacity, try again shortly' });
      return;
    }
    // Idempotent: returns the existing room if it is already up. The caps live
    // here so they hold even if a client is modified.
    await rooms.createRoom({
      name: roomId,
      maxParticipants: config.maxParticipants,
      emptyTimeout: config.emptyTimeout,
      departureTimeout: 20,
    });
  } catch (err) {
    send(res, 502, { error: `could not reach the media server: ${describe(err)}` });
    return;
  }

  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity,
    // No name: display names stay inside the encrypted channel.
    ttl: config.tokenTtlSeconds,
    // Server-attested, so other participants can trust the host badge.
    metadata: JSON.stringify({ host: isHost }),
  });
  at.addGrant({
    room: roomId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    // No room admin, no recording, no ability to mint for other rooms.
    roomCreate: false,
    roomList: false,
    roomRecord: false,
    roomAdmin: false,
    hidden: false,
  });

  const record = registry.ensure(roomId);
  record.admitted.add(identity);
  if (isHost) record.hostIdentities.add(identity);

  stats.tokens++;
  send(res, 200, {
    token: await at.toJwt(),
    url: config.publicWsUrl,
    host: isHost,
    locked: record.locked,
    maxParticipants: config.maxParticipants,
  });
}

/**
 * Host moderation. Enforced here and in LiveKit, not by asking clients nicely:
 * a removed participant is disconnected by the media server, and everyone
 * left rotates to a fresh key the removed participant never receives.
 */
async function handleHost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!limiter.check(clientKey(req.socket.remoteAddress))) {
    stats.rateLimited++;
    send(res, 429, { error: 'too many requests' });
    return;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    send(res, 400, { error: 'bad request body' });
    return;
  }
  const { roomId, hostKey, action, identity } = (body ?? {}) as Record<string, unknown>;
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId) || !RoomRegistry.validHostKey(hostKey)) {
    send(res, 400, { error: 'invalid request' });
    return;
  }
  if (!registry.isHostKey(roomId, hostKey)) {
    send(res, 403, { error: 'not the host of this room' });
    return;
  }
  const record = registry.ensure(roomId);
  try {
    switch (action) {
      case 'lock':
      case 'unlock':
        record.locked = action === 'lock';
        break;
      case 'remove':
      case 'mute': {
        if (typeof identity !== 'string' || !IDENTITY.test(identity)) {
          send(res, 400, { error: 'invalid identity' });
          return;
        }
        if (record.hostIdentities.has(identity)) {
          send(res, 400, { error: 'a host cannot be moderated' });
          return;
        }
        if (action === 'remove') {
          record.admitted.delete(identity);
          relay.drop(roomId, identity);
          await rooms.removeParticipant(roomId, identity);
        } else {
          const participant = await rooms.getParticipant(roomId, identity);
          for (const track of participant.tracks) {
            if (track.source === TrackSource.MICROPHONE && !track.muted) {
              await rooms.mutePublishedTrack(roomId, identity, track.sid, true);
            }
          }
        }
        break;
      }
      default:
        send(res, 400, { error: 'unknown action' });
        return;
    }
  } catch (err) {
    send(res, 502, { error: `moderation failed: ${describe(err)}` });
    return;
  }
  stats.moderation++;
  send(res, 200, { ok: true, locked: record.locked });
}

const server = createServer((req, res) => {
  void (async () => {
    if (!applyCors(req, res)) {
      send(res, 403, { error: 'origin not allowed' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/token') {
      await handleToken(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/host') {
      await handleHost(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(res, 200, {
        ok: true,
        maxParticipants: config.maxParticipants,
        // Aggregates only. No addresses, no room ids, no names.
        stats,
        signal: { ...relay.stats, rooms: relay.rooms },
        rateBuckets: limiter.size,
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  })().catch((err) => {
    send(res, 500, { error: describe(err) });
  });
});

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const relay = attachSignalRelay(server, {
  maxParticipants: config.maxParticipants,
  isAdmitted: (roomId, identity) => registry.isAdmitted(roomId, identity),
});

const sweep = setInterval(() => {
  limiter.sweep();
  void rooms
    .listRooms()
    .then((live) => registry.sweep(new Set(live.map((r) => r.name)), 5 * 60_000))
    .catch(() => undefined);
}, 60_000);
sweep.unref();

server.listen(config.port, config.host, () => {
  console.log(
    `shh vc token service on http://${config.host}:${config.port} ` +
      `(max ${config.maxParticipants}/room, ttl ${config.tokenTtlSeconds}s, no persistence); ` +
      `key-agreement relay on ws://${config.host}:${config.port}/api/signal`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
