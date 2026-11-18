import { describe, expect, it } from 'vitest';
import { toB64Url } from '../src/crypto/bytes.ts';
import {
  classifyChange,
  effectiveLevel,
  HOST_GRACE_MS,
  hostPublicKey,
  hostSeed,
  mayChange,
  signAsHost,
  verifyHost,
} from '../src/movie/control.ts';
import type { HeldState } from '../src/movie/sync.ts';
import { parseClock } from '../src/movie/sync.ts';

const key = toB64Url(new Uint8Array(32).fill(7));
const seed = hostSeed(key);
const pub = hostPublicKey(seed);

describe('host signatures', () => {
  it('verify only for the same room, payload and key', () => {
    const payload = { level: 'host', rev: 2 };
    const sig = signAsHost(seed, 'room-a', payload);
    expect(verifyHost(pub, 'room-a', payload, sig)).toBe(true);
    expect(verifyHost(pub, 'room-b', payload, sig)).toBe(false);
    expect(verifyHost(pub, 'room-a', { level: 'everyone', rev: 2 }, sig)).toBe(false);
    const other = hostPublicKey(hostSeed(toB64Url(new Uint8Array(32).fill(8))));
    expect(verifyHost(other, 'room-a', payload, sig)).toBe(false);
    expect(verifyHost(pub, 'room-a', payload, 'garbage')).toBe(false);
    expect(verifyHost(pub, 'room-a', payload, undefined)).toBe(false);
  });
});

describe('who may change playback', () => {
  it('follows the level, and the host may always', () => {
    expect(mayChange('everyone', false, 'other')).toBe(true);
    expect(mayChange('pause', false, 'pause')).toBe(true);
    expect(mayChange('pause', false, 'other')).toBe(false);
    expect(mayChange('host', false, 'pause')).toBe(false);
    expect(mayChange('host', true, 'other')).toBe(true);
  });

  it('opens to everyone once the host has been gone 30 seconds', () => {
    expect(effectiveLevel('host', 1000, 1000 + HOST_GRACE_MS - 1, false)).toBe('host');
    expect(effectiveLevel('host', 1000, 1000 + HOST_GRACE_MS, false)).toBe('everyone');
    expect(effectiveLevel('host', 0, 10 ** 12, true)).toBe('host');
  });

  it('counts only a stop at the same moment as a pause', () => {
    const now = 100_000;
    const held: HeldState = { url: 'own', kind: 'own', title: 'Ep 1', playing: true, position: 60, rev: 3, by: 'a', receivedAt: now - 2000 };
    const base = { url: 'own', kind: 'own' as const, title: 'Ep 1', rev: 4, by: 'b' };
    expect(classifyChange(held, { ...base, playing: false, position: 62 }, now)).toBe('pause');
    expect(classifyChange(held, { ...base, playing: false, position: 300 }, now)).toBe('other');
    expect(classifyChange(held, { ...base, playing: true, position: 62 }, now)).toBe('other');
    expect(classifyChange(held, { ...base, title: 'Ep 2', playing: false, position: 62 }, now)).toBe('other');
    expect(classifyChange(undefined, { ...base, playing: false, position: 0 }, now)).toBe('other');
  });
});

describe('jump-to times', () => {
  it('parses h:mm:ss, m:ss and seconds', () => {
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('12:30')).toBe(750);
    expect(parseClock(' 90 ')).toBe(90);
    expect(parseClock('1:75')).toBeUndefined();
    expect(parseClock('abc')).toBeUndefined();
    expect(parseClock('')).toBeUndefined();
  });
});
