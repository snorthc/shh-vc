import { describe, expect, it } from 'vitest';
import {
  compareBytes,
  fromB64Url,
  randomBytes,
  timingSafeEqual,
  toB64Url,
} from '../src/crypto/bytes.ts';
import {
  ROOM_ID_CHARS,
  deriveRoomSecret,
  fromFragment,
  joinLink,
  newRoomSecret,
  toFragment,
} from '../src/crypto/secret.ts';
import { newIdentity, sharedSecret } from '../src/crypto/identity.ts';
import {
  GroupKeys,
  KEYRING_SIZE,
  MEDIA_KEY_BYTES,
  ratchetMaterial,
} from '../src/crypto/group.ts';
import { participantCode, roomSafetyNumber } from '../src/crypto/safety.ts';
import { decodeMessage, encodeMessage, WIRE_VERSION } from '../src/crypto/wire.ts';

describe('base64url', () => {
  it('round-trips every length from 0 to 64', () => {
    for (let n = 0; n <= 64; n++) {
      const b = randomBytes(n);
      expect(Array.from(fromB64Url(toB64Url(b)))).toEqual(Array.from(b));
    }
  });

  it('emits no padding or non-url characters', () => {
    const s = toB64Url(randomBytes(32));
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('timingSafeEqual', () => {
  it('compares by value and rejects length mismatches', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('room secret', () => {
  it('derives a stable room id and auth key from the same secret', () => {
    const raw = randomBytes(32);
    const a = deriveRoomSecret(raw);
    const b = deriveRoomSecret(raw);
    expect(a.roomId).toBe(b.roomId);
    expect(Array.from(a.authKey)).toEqual(Array.from(b.authKey));
    expect(a.roomId).toHaveLength(ROOM_ID_CHARS);
  });

  it('gives different room ids for different secrets', () => {
    expect(newRoomSecret().roomId).not.toBe(newRoomSecret().roomId);
  });

  it('never exposes the secret through the room id', () => {
    const rs = newRoomSecret();
    // The server sees roomId. It must not contain the secret's encoding.
    expect(rs.roomId).not.toContain(toB64Url(rs.secret).slice(0, 8));
    expect(rs.roomId).not.toContain(toB64Url(rs.authKey).slice(0, 8));
  });

  it('round-trips through a link fragment', () => {
    const rs = newRoomSecret();
    const parsed = fromFragment(toFragment(rs));
    expect(parsed).not.toBeNull();
    expect(parsed!.roomId).toBe(rs.roomId);
    expect(Array.from(parsed!.secret)).toEqual(Array.from(rs.secret));
  });

  it('puts the secret after the # and nowhere else in the link', () => {
    const rs = newRoomSecret();
    const link = joinLink('https://veil.example', rs);
    const [before, after] = link.split('#');
    expect(after).toContain(toB64Url(rs.secret));
    expect(before).not.toContain(toB64Url(rs.secret));
  });

  it('rejects malformed, short and absent fragments', () => {
    expect(fromFragment('')).toBeNull();
    expect(fromFragment('#')).toBeNull();
    expect(fromFragment('#k=')).toBeNull();
    expect(fromFragment('#nope=1')).toBeNull();
    expect(fromFragment(`#k=${toB64Url(randomBytes(16))}`)).toBeNull();
    expect(fromFragment(`#k=${toB64Url(randomBytes(33))}`)).toBeNull();
  });

  it('refuses to derive from a wrong-sized secret', () => {
    expect(() => deriveRoomSecret(randomBytes(31))).toThrow();
  });
});

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('x25519', () => {
  it('agrees on a shared secret in both directions', () => {
    const a = newIdentity();
    const b = newIdentity();
    expect(Array.from(sharedSecret(a.privateKey, b.publicKey))).toEqual(
      Array.from(sharedSecret(b.privateKey, a.publicKey)),
    );
  });

  it('rejects low-order public keys (contributory behaviour)', () => {
    const a = newIdentity();
    // @noble/curves already refuses an all-zero shared secret; our own guard
    // is defence in depth for any curve implementation that would not. Either
    // rejection is acceptable, silently returning zeros is not.
    expect(() => sharedSecret(a.privateKey, new Uint8Array(32))).toThrow();
    // The known low-order X25519 points (the libsodium blacklist) all yield an
    // all-zero shared secret and must be refused, not silently accepted.
    const lowOrder = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
      '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ];
    for (const hex of lowOrder) {
      expect(() => sharedSecret(a.privateKey, hexToBytes(hex))).toThrow();
    }
  });

  it('rejects wrong-length public keys', () => {
    const a = newIdentity();
    expect(() => sharedSecret(a.privateKey, randomBytes(31))).toThrow();
  });
});

function member(rs: ReturnType<typeof newRoomSecret>, id: string, name = id): GroupKeys {
  return new GroupKeys({
    roomSecret: rs,
    identity: newIdentity(),
    selfIdentity: id,
    displayName: name,
  });
}

describe('group key agreement', () => {
  it('lets two link holders exchange a media key', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    const bob = member(rs, 'bob');
    alice.startSenderKey();
    bob.startSenderKey();

    expect(await bob.acceptAnnounce(alice.buildAnnounce())).not.toBeNull();
    expect(await alice.acceptAnnounce(bob.buildAnnounce())).not.toBeNull();

    const got = await bob.open(await alice.sealFor('bob'));
    expect(got).not.toBeNull();
    expect(got!.from).toBe('alice');
    expect(got!.material).toHaveLength(MEDIA_KEY_BYTES);
    expect(Array.from(got!.material)).toEqual(Array.from(alice.material));
  });

  it('rejects an announcement from someone without the room secret', async () => {
    const rs = newRoomSecret();
    const other = newRoomSecret();
    const alice = member(rs, 'alice');
    const impostor = member(other, 'mallory');
    expect(await alice.acceptAnnounce(impostor.buildAnnounce())).toBeNull();
  });

  it('rejects an announcement whose public key was swapped in transit', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    const bob = member(rs, 'bob');
    const forged = { ...bob.buildAnnounce(), pk: toB64Url(newIdentity().publicKey) };
    expect(await alice.acceptAnnounce(forged)).toBeNull();
  });

  it('rejects an announcement replayed under a different identity', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    const bob = member(rs, 'bob');
    const replayed = { ...bob.buildAnnounce(), id: 'bob-2' };
    expect(await alice.acceptAnnounce(replayed)).toBeNull();
  });

  it('ignores our own announcement echoed back', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    expect(await alice.acceptAnnounce(alice.buildAnnounce())).toBeNull();
  });

  it('refuses to seal for an unverified peer', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    alice.startSenderKey();
    await expect(alice.sealFor('nobody')).rejects.toThrow();
  });

  it('will not open an envelope addressed to someone else', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    const bob = member(rs, 'bob');
    const carol = member(rs, 'carol');
    alice.startSenderKey();
    await alice.acceptAnnounce(bob.buildAnnounce());
    await alice.acceptAnnounce(carol.buildAnnounce());
    await bob.acceptAnnounce(alice.buildAnnounce());
    await carol.acceptAnnounce(alice.buildAnnounce());

    const forBob = await alice.sealFor('bob');
    expect(await carol.open(forBob)).toBeNull();
    expect(await bob.open(forBob)).not.toBeNull();
  });

  it('will not open an envelope whose key index was tampered with', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    const bob = member(rs, 'bob');
    alice.startSenderKey();
    await alice.acceptAnnounce(bob.buildAnnounce());
    await bob.acceptAnnounce(alice.buildAnnounce());
    const env = await alice.sealFor('bob');
    expect(await bob.open({ ...env, ki: (env.ki + 1) % KEYRING_SIZE })).toBeNull();
  });

  it('will not open an envelope whose ciphertext was flipped', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    const bob = member(rs, 'bob');
    alice.startSenderKey();
    await alice.acceptAnnounce(bob.buildAnnounce());
    await bob.acceptAnnounce(alice.buildAnnounce());
    const env = await alice.sealFor('bob');
    const ct = fromB64Url(env.ct);
    ct[0] = ct[0]! ^ 0x01;
    expect(await bob.open({ ...env, ct: toB64Url(ct) })).toBeNull();
  });

  it('will not open an envelope from an unverified sender', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'alice');
    const bob = member(rs, 'bob');
    alice.startSenderKey();
    await alice.acceptAnnounce(bob.buildAnnounce());
    // bob never verified alice, so he has no pairwise key for her
    expect(await bob.open(await alice.sealFor('bob'))).toBeNull();
  });

  it('does not accept a key wrapped for a different room', async () => {
    // Same two identities, two different rooms: the wrap key is room-bound.
    const idA = newIdentity();
    const idB = newIdentity();
    const r1 = newRoomSecret();
    const r2 = newRoomSecret();
    const a1 = new GroupKeys({ roomSecret: r1, identity: idA, selfIdentity: 'a' });
    const b1 = new GroupKeys({ roomSecret: r1, identity: idB, selfIdentity: 'b' });
    const b2 = new GroupKeys({ roomSecret: r2, identity: idB, selfIdentity: 'b' });
    a1.startSenderKey();
    await a1.acceptAnnounce(b1.buildAnnounce());
    await b1.acceptAnnounce(a1.buildAnnounce());
    // b2 must verify a's announce under r2's auth key, which fails:
    const announceInR1 = a1.buildAnnounce();
    expect(await b2.acceptAnnounce(announceInR1)).toBeNull();
  });
});

describe('display names', () => {
  it('carries the name inside the authenticated announcement', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'id-a', 'Alice');
    const bob = member(rs, 'id-b', 'Bob');
    const peer = await bob.acceptAnnounce(alice.buildAnnounce());
    expect(peer!.displayName).toBe('Alice');
  });

  it('rejects an announcement whose name was altered in transit', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'id-a', 'Alice');
    const bob = member(rs, 'id-b', 'Bob');
    const tampered = { ...alice.buildAnnounce(), nm: 'Administrator' };
    expect(await bob.acceptAnnounce(tampered)).toBeNull();
  });

  it('truncates oversized names rather than rejecting the participant', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'id-a', 'x'.repeat(500));
    const bob = member(rs, 'id-b', 'Bob');
    const peer = await bob.acceptAnnounce(alice.buildAnnounce());
    expect(peer).not.toBeNull();
    expect(peer!.displayName.length).toBeLessThanOrEqual(48);
  });

  it('accepts an empty name', async () => {
    const rs = newRoomSecret();
    const alice = member(rs, 'id-a', '');
    const bob = member(rs, 'id-b', 'Bob');
    const peer = await bob.acceptAnnounce(alice.buildAnnounce());
    expect(peer!.displayName).toBe('');
  });
});

describe('rotation policy', () => {
  it('produces an unrelated key on leave, so the departed cannot follow', () => {
    const alice = member(newRoomSecret(), 'alice');
    alice.startSenderKey();
    const before = Uint8Array.from(alice.material);
    alice.rotateSenderKey();
    const after = Uint8Array.from(alice.material);
    expect(Array.from(after)).not.toEqual(Array.from(before));
    expect(alice.keyIndex).toBe(1);
  });

  it('ratchets deterministically, so every member lands on the same key', () => {
    const seed = randomBytes(MEDIA_KEY_BYTES);
    const once = ratchetMaterial(seed);
    expect(Array.from(ratchetMaterial(seed))).toEqual(Array.from(once));
    expect(Array.from(once)).not.toEqual(Array.from(seed));
    expect(once).toHaveLength(MEDIA_KEY_BYTES);
  });

  it('ratchets one-way: the next key does not reveal the previous one', () => {
    const seed = randomBytes(MEDIA_KEY_BYTES);
    const k1 = ratchetMaterial(seed);
    const k2 = ratchetMaterial(k1);
    expect(Array.from(k2)).not.toEqual(Array.from(k1));
    expect(Array.from(k2)).not.toEqual(Array.from(seed));
    // No cycle within a keyring's worth of steps.
    const seen = new Set<string>([toB64Url(seed)]);
    let cur = seed;
    for (let i = 0; i < KEYRING_SIZE * 4; i++) {
      cur = ratchetMaterial(cur);
      const enc = toB64Url(cur);
      expect(seen.has(enc)).toBe(false);
      seen.add(enc);
    }
  });

  it('refuses to ratchet material of the wrong size', () => {
    expect(() => ratchetMaterial(randomBytes(16))).toThrow();
  });

  it('keeps two members in lockstep when both ratchet on a join', () => {
    const rs = newRoomSecret();
    const a = member(rs, 'a');
    const b = member(rs, 'b');
    const shared = randomBytes(MEDIA_KEY_BYTES);
    a.adoptSenderKey(shared, 0);
    b.adoptSenderKey(shared, 0);
    a.ratchetSenderKey();
    b.ratchetSenderKey();
    expect(Array.from(a.material)).toEqual(Array.from(b.material));
    expect(a.keyIndex).toBe(1);
    expect(b.keyIndex).toBe(1);
    expect(Array.from(a.material)).not.toEqual(Array.from(shared));
  });

  it('validates arguments to adoptSenderKey', () => {
    const a = member(newRoomSecret(), 'a');
    expect(() => a.adoptSenderKey(randomBytes(16), 0)).toThrow();
    expect(() => a.adoptSenderKey(randomBytes(MEDIA_KEY_BYTES), KEYRING_SIZE)).toThrow();
    expect(() => a.adoptSenderKey(randomBytes(MEDIA_KEY_BYTES), -1)).toThrow();
    expect(() => a.adoptSenderKey(randomBytes(MEDIA_KEY_BYTES), 1.5)).toThrow();
  });

  it('copies adopted material so later mutation of the caller buffer is inert', () => {
    const a = member(newRoomSecret(), 'a');
    const buf = randomBytes(MEDIA_KEY_BYTES);
    a.adoptSenderKey(buf, 0);
    const snapshot = Array.from(a.material);
    buf.fill(0);
    expect(Array.from(a.material)).toEqual(snapshot);
  });

  it('wraps the key index around the keyring instead of overflowing', () => {
    const alice = member(newRoomSecret(), 'alice');
    alice.startSenderKey();
    for (let i = 0; i < KEYRING_SIZE; i++) alice.rotateSenderKey();
    expect(alice.keyIndex).toBe(0);
    for (let i = 0; i < KEYRING_SIZE * 3 + 5; i++) alice.ratchetSenderKey();
    expect(alice.keyIndex).toBeGreaterThanOrEqual(0);
    expect(alice.keyIndex).toBeLessThan(KEYRING_SIZE);
  });

  it('routes advance() to the right primitive per reason', () => {
    const a = member(newRoomSecret(), 'a');
    a.advance('init');
    const k0 = Uint8Array.from(a.material);
    a.advance('join');
    const k1 = Uint8Array.from(a.material);
    a.advance('leave');
    const k2 = Uint8Array.from(a.material);
    expect(Array.from(k1)).not.toEqual(Array.from(k0));
    expect(Array.from(k2)).not.toEqual(Array.from(k1));
    expect(a.keyIndex).toBe(2);
  });

  it('throws rather than sending an uninitialised all-zero key', () => {
    const a = member(newRoomSecret(), 'a');
    expect(() => a.material).toThrow(/not initialised/);
  });
});

describe('safety numbers', () => {
  it('gives each key a stable, readable code', () => {
    const id = newIdentity();
    expect(participantCode(id.publicKey)).toBe(participantCode(id.publicKey));
    expect(participantCode(id.publicKey)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('gives different keys different codes', () => {
    expect(participantCode(newIdentity().publicKey)).not.toBe(
      participantCode(newIdentity().publicKey),
    );
  });

  it('computes the room number independent of participant order', () => {
    const keys = [newIdentity().publicKey, newIdentity().publicKey, newIdentity().publicKey];
    const forward = roomSafetyNumber(keys);
    const reversed = roomSafetyNumber([...keys].reverse());
    const shuffled = roomSafetyNumber([keys[2]!, keys[0]!, keys[1]!]);
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it('changes the room number when the set of participants changes', () => {
    const a = newIdentity().publicKey;
    const b = newIdentity().publicKey;
    const c = newIdentity().publicKey;
    expect(roomSafetyNumber([a, b])).not.toBe(roomSafetyNumber([a, b, c]));
    expect(roomSafetyNumber([a, b])).not.toBe(roomSafetyNumber([a, c]));
  });

  it('agrees across participants who verified each other', async () => {
    const rs = newRoomSecret();
    const a = member(rs, 'a');
    const b = member(rs, 'b');
    const c = member(rs, 'c');
    for (const [x, y] of [
      [a, b],
      [a, c],
      [b, a],
      [b, c],
      [c, a],
      [c, b],
    ] as const) {
      await x.acceptAnnounce(y.buildAnnounce());
    }
    expect(a.safetyNumber()).toBe(b.safetyNumber());
    expect(b.safetyNumber()).toBe(c.safetyNumber());
  });

  it('diverges if one participant was fed a different key for a peer', async () => {
    const rs = newRoomSecret();
    const a = member(rs, 'a');
    const b = member(rs, 'b');
    await a.acceptAnnounce(b.buildAnnounce());
    const alone = a.safetyNumber();
    await b.acceptAnnounce(a.buildAnnounce());
    expect(b.safetyNumber()).toBe(alone);
    const c = member(rs, 'c');
    await b.acceptAnnounce(c.buildAnnounce());
    expect(b.safetyNumber()).not.toBe(a.safetyNumber());
  });
});

describe('wire decoding of untrusted input', () => {
  it('round-trips valid messages', () => {
    const rs = newRoomSecret();
    const a = member(rs, 'a');
    const msg = a.buildAnnounce();
    expect(decodeMessage(encodeMessage(msg))).toEqual(msg);
    const req = a.buildRekeyRequest();
    expect(decodeMessage(encodeMessage(req))).toEqual(req);
  });

  it('rejects junk, wrong versions and bad key indices', () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(decodeMessage(new TextEncoder().encode('not json'))).toBeNull();
    expect(decodeMessage(enc(null))).toBeNull();
    expect(decodeMessage(enc([1, 2, 3]))).toBeNull();
    expect(decodeMessage(enc({ v: 999, t: 'announce', id: 'a', pk: 'x', mac: 'y' }))).toBeNull();
    expect(decodeMessage(enc({ v: WIRE_VERSION, t: 'nope', id: 'a' }))).toBeNull();
    expect(decodeMessage(enc({ v: WIRE_VERSION, t: 'announce', id: '', pk: 'x', mac: 'y' }))).toBeNull();
    expect(
      decodeMessage(enc({ v: WIRE_VERSION, t: 'key', id: 'a', to: 'b', ki: 16, n: 'x', ct: 'y' })),
    ).toBeNull();
    expect(
      decodeMessage(enc({ v: WIRE_VERSION, t: 'key', id: 'a', to: 'b', ki: -1, n: 'x', ct: 'y' })),
    ).toBeNull();
    expect(
      decodeMessage(enc({ v: WIRE_VERSION, t: 'key', id: 'a', to: 'b', ki: 1.5, n: 'x', ct: 'y' })),
    ).toBeNull();
    expect(decodeMessage(enc({ v: WIRE_VERSION, t: 'key', id: 'a', to: 'b', ki: 0 }))).toBeNull();
    expect(decodeMessage(enc({ v: WIRE_VERSION, t: 'announce', id: 'x'.repeat(200), pk: 'a', mac: 'b' }))).toBeNull();
  });
});

describe('compareBytes', () => {
  it('orders lexicographically and by length', () => {
    expect(compareBytes(new Uint8Array([1]), new Uint8Array([2]))).toBeLessThan(0);
    expect(compareBytes(new Uint8Array([2]), new Uint8Array([1]))).toBeGreaterThan(0);
    expect(compareBytes(new Uint8Array([1]), new Uint8Array([1]))).toBe(0);
    expect(compareBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBeLessThan(0);
  });
});
