/**
 * The room secret.
 *
 * INVARIANT: the 32-byte room secret exists only in the URL fragment and in
 * memory. It is never placed in a path, query string, header, body, log, or
 * any form of storage. The server only ever learns `roomId`, which is a hash
 * of the secret, so the server cannot derive the secret, the auth key, or any
 * media key.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { fromB64Url, randomBytes, toB64Url, utf8 } from './bytes.ts';

export const SECRET_BYTES = 32;
/** Length of the server-visible room id, in base64url characters. */
export const ROOM_ID_CHARS = 32;

const DOMAIN = 'veil/v1';

export interface RoomSecret {
  /** Raw 32-byte secret. Keep in memory only. */
  readonly secret: Uint8Array;
  /** What the server sees: SHA-256 of the secret, base64url, truncated. */
  readonly roomId: string;
  /** HMAC key that binds key-exchange messages to possession of the secret. */
  readonly authKey: Uint8Array;
}

export function newRoomSecret(): RoomSecret {
  return deriveRoomSecret(randomBytes(SECRET_BYTES));
}

export function deriveRoomSecret(secret: Uint8Array): RoomSecret {
  if (secret.length !== SECRET_BYTES) {
    throw new Error(`room secret must be ${SECRET_BYTES} bytes, got ${secret.length}`);
  }
  const roomId = toB64Url(sha256(new Uint8Array([...utf8(`${DOMAIN}/room-id`), ...secret]))).slice(
    0,
    ROOM_ID_CHARS,
  );
  const authKey = hkdf(sha256, secret, utf8(DOMAIN), utf8(`${DOMAIN}/auth`), 32);
  return { secret, roomId, authKey };
}

/** Encode the secret as the fragment of a join link. */
export function toFragment(rs: RoomSecret): string {
  return `#k=${toB64Url(rs.secret)}`;
}

export function joinLink(origin: string, rs: RoomSecret): string {
  return `${origin.replace(/\/+$/, '')}/${toFragment(rs)}`;
}

/**
 * Parse a secret out of a location fragment. Returns null when absent or
 * malformed — callers must treat null as "no room", never as "empty secret".
 */
export function fromFragment(hash: string): RoomSecret | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const k = params.get('k');
  if (!k) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromB64Url(k);
  } catch {
    return null;
  }
  if (bytes.length !== SECRET_BYTES) return null;
  return deriveRoomSecret(bytes);
}
