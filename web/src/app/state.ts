/** App-level state: which screen is showing and which room we are in. */
import { effect, signal } from '@preact/signals';
import type { ComponentType } from 'preact';
import { JoinError } from '../call/errors.ts';
import type { EndReason, RoomSession } from '../call/session.ts';
import { fromB64Url, randomBytes, toB64Url } from '../crypto/bytes.ts';
import {
  deriveRoomSecret,
  joinLink,
  newRoomSecret,
  type RoomSecret,
  SECRET_BYTES,
} from '../crypto/secret.ts';
import { DIRECT } from './mode.ts';
import { settings } from './settings.ts';
import { describeError } from './util.ts';

export type View = 'landing' | 'prejoin' | 'joining' | 'room' | 'ended' | 'unsupported';

export interface PendingRoom {
  secret: RoomSecret;
  /** Set only for the person who created the room. */
  hostKey?: string;
  created: boolean;
}

export interface EndedInfo {
  reason: EndReason;
  detail?: string;
  seconds: number;
}

export const view = signal<View>('landing');
export const pending = signal<PendingRoom | undefined>(undefined);
export const session = signal<RoomSession | undefined>(undefined);
export const joinError = signal<string | undefined>(undefined);
export const ended = signal<EndedInfo | undefined>(undefined);
/** The room screen, loaded with the call engine the first time someone joins. */
export const RoomScreen = signal<ComponentType<{ session: RoomSession }> | undefined>(undefined);

/**
 * The call engine is most of the app's weight. Load it when a room is on the
 * way, not on the landing page.
 */
function loadRoom() {
  return Promise.all([import('../call/session.ts'), import('../ui/room/RoomView.tsx')]);
}

/** Start fetching the room code early, e.g. while the pre-join screen is up. */
export function preloadRoom(): void {
  void loadRoom().catch(() => undefined);
}

const HOST_KEY = /^[A-Za-z0-9_-]{22,64}$/;

function parseFragment(hash: string): PendingRoom | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return undefined;
  const params = new URLSearchParams(raw);
  const secret = secretFromKey(params.get('k') ?? '');
  if (!secret) return undefined;
  const h = params.get('h') ?? '';
  return { secret, hostKey: HOST_KEY.test(h) ? h : undefined, created: false };
}

function secretFromKey(k: string): RoomSecret | undefined {
  try {
    const bytes = fromB64Url(k);
    return bytes.length === SECRET_BYTES ? deriveRoomSecret(bytes) : undefined;
  } catch {
    return undefined;
  }
}

/** Accepts a full invite link, a bare "#k=…" fragment, or just the key. */
export function parseInvite(input: string): RoomSecret | undefined {
  const text = input.trim();
  if (!text) return undefined;
  const hashAt = text.indexOf('#');
  if (hashAt >= 0) {
    const fromHash = parseFragment(text.slice(hashAt));
    if (fromHash) return fromHash.secret;
  }
  const kAt = text.indexOf('k=');
  if (kAt >= 0) {
    const s = secretFromKey(text.slice(kAt + 2).split('&')[0] ?? '');
    if (s) return s;
  }
  return secretFromKey(text);
}

/**
 * The address bar is the only place the room secret is kept. The host key
 * rides alongside it for the creator, so a reload keeps them host; it is
 * never part of the invite link.
 */
function writeFragment(room: PendingRoom | undefined): void {
  const url = new URL(location.href);
  url.hash = room
    ? `k=${toB64Url(room.secret.secret)}${room.hostKey ? `&h=${room.hostKey}` : ''}`
    : '';
  history.replaceState(null, '', room ? url.toString() : url.pathname + url.search);
}

export function inviteLink(secret: RoomSecret): string {
  return joinLink(location.origin + location.pathname.replace(/\/$/, ''), secret);
}

export function e2eeSupported(): boolean {
  return (
    typeof (window as unknown as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform !== 'undefined' ||
    (typeof RTCRtpSender !== 'undefined' && 'createEncodedStreams' in RTCRtpSender.prototype)
  );
}

export function boot(): void {
  if (!e2eeSupported()) {
    view.value = 'unsupported';
    return;
  }
  const fromUrl = parseFragment(location.hash);
  if (fromUrl) {
    pending.value = fromUrl;
    view.value = 'prejoin';
  } else {
    view.value = 'landing';
  }
}

export function startNewRoom(): void {
  const room: PendingRoom = {
    secret: newRoomSecret(),
    // Host controls need a server to enforce them; without one there is no host.
    hostKey: DIRECT ? undefined : toB64Url(randomBytes(24)),
    created: true,
  };
  pending.value = room;
  joinError.value = undefined;
  writeFragment(room);
  view.value = 'prejoin';
}

export function openInvite(input: string): boolean {
  const secret = parseInvite(input);
  if (!secret) return false;
  const room: PendingRoom = { secret, created: false };
  pending.value = room;
  joinError.value = undefined;
  writeFragment(room);
  view.value = 'prejoin';
  return true;
}

export async function join(opts: { mic: boolean; camera: boolean }): Promise<void> {
  const room = pending.value;
  if (!room) return;
  joinError.value = undefined;
  view.value = 'joining';
  let s: RoomSession | undefined;
  try {
    const [engine, ui] = await loadRoom();
    RoomScreen.value = ui.RoomView;
    s = new engine.RoomSession({
      roomSecret: room.secret,
      displayName: settings.value.name.trim() || 'Guest',
      hostKey: room.hostKey,
    });
    await s.connect();
  } catch (err) {
    await s?.leave('failed').catch(() => undefined);
    joinError.value =
      err instanceof JoinError
        ? err.status === 409
          ? 'This room is full. Rooms hold six people.'
          : err.status === 423
            ? 'The host has locked this room. Ask them to unlock it.'
            : err.status === 429
              ? 'Too many attempts. Wait a minute and try again.'
              : err.message
        : `Could not connect. ${describeError(err)}`;
    view.value = 'prejoin';
    return;
  }
  session.value = s;
  view.value = 'room';
  if (opts.mic) await s.setMic(true, true);
  if (opts.camera) await s.setCamera(true);
}

export async function leaveRoom(): Promise<void> {
  await session.value?.leave('left');
}

export function backToStart(): void {
  session.value = undefined;
  pending.value = undefined;
  ended.value = undefined;
  joinError.value = undefined;
  writeFragment(undefined);
  view.value = 'landing';
}

export function rejoin(): void {
  session.value = undefined;
  ended.value = undefined;
  if (pending.value) view.value = 'prejoin';
  else backToStart();
}

// When a session ends for any reason, show why.
effect(() => {
  const s = session.value;
  if (!s || s.status.value !== 'ended') return;
  const started = s.startedAt.peek();
  ended.value = {
    reason: s.endReason.peek() ?? 'left',
    detail: s.endDetail.peek(),
    seconds: started ? (Date.now() - started) / 1000 : 0,
  };
  view.value = 'ended';
});

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (view.peek() === 'room' || view.peek() === 'joining') return;
    boot();
  });
  // Handle for end-to-end tests and for debugging from the console.
  (window as unknown as { __shh?: unknown }).__shh = { session, view, settings };
}
