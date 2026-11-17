/**
 * In-memory rate limiter.
 *
 * Keys are a truncated HMAC of the client address under a secret generated at
 * boot, so the table cannot be read back into a list of visitor IPs, and the
 * mapping dies with the process. Nothing is persisted.
 */
import { createHmac, randomBytes } from 'node:crypto';

const PEPPER = randomBytes(32);

export function clientKey(remoteAddress: string | undefined): string {
  return createHmac('sha256', PEPPER)
    .update(remoteAddress ?? 'unknown')
    .digest('base64url')
    .slice(0, 16);
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  // Explicit fields rather than TypeScript parameter properties: Node's
  // --experimental-strip-types only erases types, it does not transform.
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** True when the request is allowed. */
  check(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length >= this.limit) {
      this.hits.set(key, times);
      return false;
    }
    times.push(now);
    this.hits.set(key, times);
    return true;
  }

  /** Drop stale buckets so an idle process does not grow without bound. */
  sweep(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      const live = times.filter((t) => t > cutoff);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
