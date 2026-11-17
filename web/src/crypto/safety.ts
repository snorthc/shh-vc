/**
 * Human-verifiable fingerprints.
 *
 * Participants compare these out of band (voice, in person) to detect a
 * malicious server that injected its own key. Without this check, E2EE
 * protects you from a *passive* server only.
 */
import { sha256 } from '@noble/hashes/sha2';
import { compareBytes, concat, lpb, utf8 } from './bytes.ts';

/** Crockford-style alphabet: no I, L, O, U — unambiguous when read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, chars: number): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 0x1f]!;
    }
    if (out.length >= chars) break;
  }
  return out;
}

function group(s: string, size: number): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts.join('-');
}

/** Per-participant code, e.g. "K7M2-R9XQ". Stable for one session. */
export function participantCode(publicKey: Uint8Array): string {
  const h = sha256(concat(utf8('veil/v1/fingerprint'), lpb(publicKey)));
  return group(encodeBase32(h, 8), 4);
}

/**
 * Room-wide safety number over every participant's key, order-independent.
 * Changes whenever membership changes — that is intentional: it means
 * "the set of people holding keys right now is exactly this".
 */
export function roomSafetyNumber(publicKeys: Uint8Array[]): string {
  const sorted = [...publicKeys].sort(compareBytes);
  const h = sha256(concat(utf8('veil/v1/room-safety'), ...sorted.map(lpb)));
  return group(encodeBase32(h, 12), 4);
}
