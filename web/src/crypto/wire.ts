/**
 * Wire formats for key-agreement messages.
 *
 * These travel over the dedicated key-agreement relay, NOT over LiveKit's data
 * channel — LiveKit encrypts data messages with the sender's media key, so a
 * key could never be delivered that way. See server/src/signal.ts.
 */

export const WIRE_VERSION = 1;
/** Display names are decorative; cap them so they cannot be used as a channel. */
export const MAX_NAME_LENGTH = 48;

/** Broadcast when a participant joins: "here is my X25519 public key". */
export interface AnnounceMessage {
  v: number;
  t: 'announce';
  /** LiveKit participant identity of the sender. */
  id: string;
  /** base64url X25519 public key. */
  pk: string;
  /** Display name, chosen client-side. Authenticated by `mac`, not secret. */
  nm: string;
  /** base64url HMAC-SHA256 over (domain || id || pk) under the room auth key. */
  mac: string;
}

/** Sent to exactly one recipient: the sender's media key, wrapped. */
export interface KeyEnvelope {
  v: number;
  t: 'key';
  id: string;
  to: string;
  /** Key index in the 16-slot keyring. */
  ki: number;
  /** base64url 12-byte AES-GCM nonce. */
  n: string;
  /** base64url AES-GCM ciphertext of the 32-byte key material. */
  ct: string;
}

/** Asks peers to re-send their current key, e.g. after a reconnect. */
export interface RequestKeysMessage {
  v: number;
  t: 'rekey-request';
  id: string;
}

export type VeilMessage = AnnounceMessage | KeyEnvelope | RequestKeysMessage;

/**
 * Returns a Uint8Array explicitly backed by a non-shared ArrayBuffer, which is
 * what LiveKit's publishData requires (encoded frames may not reference a
 * SharedArrayBuffer).
 */
export function encodeMessage(m: VeilMessage): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(JSON.stringify(m));
  return encoded as Uint8Array<ArrayBuffer>;
}

/** Parses untrusted bytes from the data channel. Returns null on anything unexpected. */
export function decodeMessage(data: Uint8Array): VeilMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (m.v !== WIRE_VERSION) return null;
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 128) return null;
  switch (m.t) {
    case 'announce':
      if (typeof m.pk !== 'string' || typeof m.mac !== 'string') return null;
      if (typeof m.nm !== 'string' || m.nm.length > MAX_NAME_LENGTH) return null;
      return m as unknown as AnnounceMessage;
    case 'key':
      if (typeof m.to !== 'string' || typeof m.n !== 'string' || typeof m.ct !== 'string') {
        return null;
      }
      if (typeof m.ki !== 'number' || !Number.isInteger(m.ki) || m.ki < 0 || m.ki > 15) return null;
      return m as unknown as KeyEnvelope;
    case 'rekey-request':
      return m as unknown as RequestKeysMessage;
    default:
      return null;
  }
}
