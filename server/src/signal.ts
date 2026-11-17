/**
 * Key-agreement relay.
 *
 * Why this exists: LiveKit encrypts data-channel messages with the sender's
 * media key, so key-agreement messages cannot travel that way — a recipient
 * would need the key in order to receive the key. So key agreement gets its
 * own channel, which is also how Discord's DAVE and Jitsi do it.
 *
 * This server is a dumb broadcast relay. It does not parse payloads, cannot
 * read a media key, and cannot forge an announcement: entry to the key group
 * requires an HMAC under a key derived from the room secret, which only link
 * holders have. It keeps nothing: no disk, no history, no addresses.
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

const ROOM_ID = /^[A-Za-z0-9_-]{32}$/;
const IDENTITY = /^[A-Za-z0-9_-]{16,43}$/;
/** Key envelopes are a few hundred bytes; this is generous. */
const MAX_MESSAGE_BYTES = 8192;
/** Messages per connection per window, to stop a client flooding a room. */
const MAX_MESSAGES = 240;
const WINDOW_MS = 10_000;

interface Member {
  socket: WebSocket;
  identity: string;
  sentAt: number[];
}

export interface SignalRelayOptions {
  maxParticipants: number;
  /** Only identities that were issued a room token may use the relay. */
  isAdmitted: (roomId: string, identity: string) => boolean;
}

export function attachSignalRelay(server: Server, options: SignalRelayOptions) {
  const wss = new WebSocketServer({ noServer: true });
  /** roomId -> members. In memory only; dies with the process. */
  const rooms = new Map<string, Set<Member>>();
  const stats = { connections: 0, relayed: 0, dropped: 0 };

  function leave(roomId: string, member: Member): void {
    const members = rooms.get(roomId);
    if (!members) return;
    members.delete(member);
    if (members.size === 0) rooms.delete(roomId);
  }

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/signal') return;

    const roomId = url.searchParams.get('room') ?? '';
    const identity = url.searchParams.get('id') ?? '';
    if (!ROOM_ID.test(roomId) || !IDENTITY.test(identity)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!options.isAdmitted(roomId, identity)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const existing = rooms.get(roomId);
    if (existing && existing.size >= options.maxParticipants) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const member: Member = { socket: ws, identity, sentAt: [] };
      const members = rooms.get(roomId) ?? new Set<Member>();
      members.add(member);
      rooms.set(roomId, members);
      stats.connections++;

      ws.on('message', (data, isBinary) => {
        const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        if (raw.byteLength > MAX_MESSAGE_BYTES || isBinary) {
          stats.dropped++;
          return;
        }
        const now = Date.now();
        member.sentAt = member.sentAt.filter((t) => t > now - WINDOW_MS);
        if (member.sentAt.length >= MAX_MESSAGES) {
          stats.dropped++;
          return;
        }
        member.sentAt.push(now);

        // Tag with the sending connection's identity so a recipient can check
        // it against the identity inside the signed payload, then broadcast.
        // The relay never looks inside `payload`.
        const framed = JSON.stringify({ from: identity, payload: raw.toString('utf8') });
        for (const peer of members) {
          if (peer === member) continue;
          if (peer.socket.readyState === peer.socket.OPEN) {
            peer.socket.send(framed);
            stats.relayed++;
          }
        }
      });

      const close = () => leave(roomId, member);
      ws.on('close', close);
      ws.on('error', close);
    });
  });

  return {
    stats,
    /** Disconnect one identity, e.g. after a host removed them. */
    drop(roomId: string, identity: string) {
      for (const member of rooms.get(roomId) ?? []) {
        if (member.identity === identity) member.socket.close(4001, 'removed');
      }
    },
    get rooms() {
      return rooms.size;
    },
    close() {
      wss.close();
    },
  };
}
