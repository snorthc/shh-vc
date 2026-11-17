/**
 * Per-session participant identity: an ephemeral X25519 key pair.
 *
 * Ephemeral by design — a new pair every page load. There is no long-term
 * identity to correlate across calls, which is the point of a no-signup
 * product. The cost is that "is this the same person as last week" is a
 * question the system cannot answer, and must not pretend to.
 */
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes } from './bytes.ts';

export interface Identity {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export function newIdentity(): Identity {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * X25519 raw shared secret. Rejects the all-zero output, which is what a
 * low-order public key produces (RFC 7748 contributory-behaviour check).
 */
export function sharedSecret(priv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  if (theirPub.length !== 32) throw new Error('peer public key must be 32 bytes');
  const ss = x25519.getSharedSecret(priv, theirPub);
  let acc = 0;
  for (const b of ss) acc |= b;
  if (acc === 0) throw new Error('rejected low-order peer public key');
  return ss;
}
