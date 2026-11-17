/** Byte / base64url helpers. No dependencies on DOM or Node specifics. */

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toB64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2]!;
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

export function fromB64Url(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9\-_]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64URL_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('invalid base64url');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const encoder = new TextEncoder();

/** Length-prefixed UTF-8 encoding, so concatenations are unambiguous. */
export function lp(s: string): Uint8Array {
  const b = encoder.encode(s);
  if (b.length > 0xffff) throw new Error('string too long to length-prefix');
  return concat(new Uint8Array([(b.length >> 8) & 0xff, b.length & 0xff]), b);
}

/** Length-prefixed raw bytes. */
export function lpb(b: Uint8Array): Uint8Array {
  if (b.length > 0xffff) throw new Error('buffer too long to length-prefix');
  return concat(new Uint8Array([(b.length >> 8) & 0xff, b.length & 0xff]), b);
}

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Constant-time comparison. Always compares the full length of `a`. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Lexicographic byte comparison. Used to canonically order public keys. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
