/**
 * Group key agreement: X25519 ECDH for pairwise wrapping, per-sender AES-GCM
 * media keys, rotated on every membership change.
 *
 * Properties this gives you:
 *   - Only holders of the room secret can enter the key group. Announcements
 *     are HMAC'd under a key derived from the secret, which the server never
 *     sees, so the server cannot inject a participant.
 *   - Each sender has its own media key; nobody can forge another's frames.
 *   - A participant who LEAVES cannot decrypt anything sent afterwards
 *     (fresh random key, redistributed).
 *   - A participant who JOINS cannot decrypt anything sent before
 *     (one-way ratchet, and the new value is what gets distributed).
 *
 * Properties it does NOT give you, stated plainly:
 *   - No post-compromise security. If a device is compromised, rotating via
 *     ratchet does not heal it. MLS would; this does not.
 *   - No protection of metadata. The server sees who is in the room, when,
 *     from which IP, and how much each person is sending.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import {
  compareBytes,
  concat,
  fromB64Url,
  lp,
  lpb,
  randomBytes,
  timingSafeEqual,
  toB64Url,
  utf8,
} from './bytes.ts';
import { type Identity, sharedSecret } from './identity.ts';
import type { RoomSecret } from './secret.ts';
import { participantCode, roomSafetyNumber } from './safety.ts';
import {
  type AnnounceMessage,
  type KeyEnvelope,
  type RequestKeysMessage,
  MAX_NAME_LENGTH,
  WIRE_VERSION,
} from './wire.ts';

/** LiveKit's keyring holds 16 slots; we cycle through them. */
export const KEYRING_SIZE = 16;
/** Media key material length. LiveKit HKDFs this down to a 128-bit AES-GCM key. */
export const MEDIA_KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * One-way key ratchet: new = HKDF(old). Pure and deterministic, so every
 * participant who holds the same material lands on the same next key without
 * any message being sent. Exported so it can be tested directly.
 */
export function ratchetMaterial(material: Uint8Array): Uint8Array {
  if (material.length !== MEDIA_KEY_BYTES) {
    throw new Error(`key material must be ${MEDIA_KEY_BYTES} bytes`);
  }
  return hkdf(sha256, material, utf8('veil/v1/ratchet'), utf8('veil/v1/ratchet'), MEDIA_KEY_BYTES);
}

export interface Peer {
  readonly identity: string;
  readonly publicKey: Uint8Array;
  /** Authenticated display name. Not unique, not verified against anything. */
  readonly displayName: string;
  /** Cached AES-GCM-256 key wrapping this peer's envelopes. */
  readonly wrapKey: CryptoKey;
}

export interface ReceivedKey {
  readonly from: string;
  readonly keyIndex: number;
  readonly material: Uint8Array;
}

export type RotationReason = 'init' | 'join' | 'leave';

function announceMac(
  authKey: Uint8Array,
  identity: string,
  publicKey: Uint8Array,
  displayName: string,
): Uint8Array {
  return hmac(
    sha256,
    authKey,
    concat(utf8('veil/v1/announce'), lp(identity), lpb(publicKey), lp(displayName)),
  );
}

async function importWrapKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Derive the pairwise wrapping key. Both sides sort the two public keys so
 * they agree without extra round trips, and the room id is mixed in so a
 * wrapping key from one room is useless in another.
 */
async function deriveWrapKey(
  ss: Uint8Array,
  roomId: string,
  a: Uint8Array,
  b: Uint8Array,
): Promise<CryptoKey> {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const raw = hkdf(
    sha256,
    ss,
    utf8(`veil/v1/wrap/${roomId}`),
    concat(utf8('veil/v1/wrap'), lpb(lo), lpb(hi)),
    32,
  );
  return importWrapKey(raw);
}

export class GroupKeys {
  readonly selfIdentity: string;
  private readonly roomSecret: RoomSecret;
  private readonly identity: Identity;
  private readonly peerMap = new Map<string, Peer>();

  private senderMaterial: Uint8Array = new Uint8Array(MEDIA_KEY_BYTES);
  private senderKeyIndex = 0;
  private started = false;

  readonly displayName: string;

  constructor(args: {
    roomSecret: RoomSecret;
    identity: Identity;
    selfIdentity: string;
    displayName?: string;
  }) {
    this.roomSecret = args.roomSecret;
    this.identity = args.identity;
    this.selfIdentity = args.selfIdentity;
    this.displayName = (args.displayName ?? '').slice(0, MAX_NAME_LENGTH);
  }

  get publicKey(): Uint8Array {
    return this.identity.publicKey;
  }

  get keyIndex(): number {
    return this.senderKeyIndex;
  }

  /** Current sender key material. Never transmitted unwrapped. */
  get material(): Uint8Array {
    if (!this.started) throw new Error('sender key not initialised');
    return this.senderMaterial;
  }

  get peerIdentities(): string[] {
    return [...this.peerMap.keys()];
  }

  peer(identity: string): Peer | undefined {
    return this.peerMap.get(identity);
  }

  /** Our own verification code, for display. */
  get selfCode(): string {
    return participantCode(this.identity.publicKey);
  }

  codeFor(identity: string): string | undefined {
    const p = this.peerMap.get(identity);
    return p ? participantCode(p.publicKey) : undefined;
  }

  /** Safety number over everyone currently holding keys, including us. */
  safetyNumber(): string {
    return roomSafetyNumber([this.identity.publicKey, ...[...this.peerMap.values()].map((p) => p.publicKey)]);
  }

  buildAnnounce(): AnnounceMessage {
    return {
      v: WIRE_VERSION,
      t: 'announce',
      id: this.selfIdentity,
      pk: toB64Url(this.identity.publicKey),
      nm: this.displayName,
      mac: toB64Url(
        announceMac(
          this.roomSecret.authKey,
          this.selfIdentity,
          this.identity.publicKey,
          this.displayName,
        ),
      ),
    };
  }

  buildRekeyRequest(): RequestKeysMessage {
    return { v: WIRE_VERSION, t: 'rekey-request', id: this.selfIdentity };
  }

  /**
   * Verify and register a peer announcement.
   *
   * Rejects: bad MAC (not a link holder, or a server-injected key), our own
   * identity echoed back, malformed keys. Returns the peer on success, null on
   * any rejection — callers must not fall back to accepting unverified keys.
   */
  async acceptAnnounce(msg: AnnounceMessage): Promise<Peer | null> {
    if (msg.id === this.selfIdentity) return null;
    let pub: Uint8Array;
    let mac: Uint8Array;
    try {
      pub = fromB64Url(msg.pk);
      mac = fromB64Url(msg.mac);
    } catch {
      return null;
    }
    if (pub.length !== 32 || mac.length !== 32) return null;
    if (typeof msg.nm !== 'string' || msg.nm.length > MAX_NAME_LENGTH) return null;
    const expected = announceMac(this.roomSecret.authKey, msg.id, pub, msg.nm);
    if (!timingSafeEqual(expected, mac)) return null;

    const existing = this.peerMap.get(msg.id);
    if (existing) {
      // A re-announce with a different key for the same identity is either a
      // reconnect or an attack; we cannot tell. Replace it, and let the
      // changed safety number be what surfaces it to the humans.
      if (timingSafeEqual(existing.publicKey, pub)) return existing;
    }

    let ss: Uint8Array;
    try {
      ss = sharedSecret(this.identity.privateKey, pub);
    } catch {
      return null;
    }
    const wrapKey = await deriveWrapKey(ss, this.roomSecret.roomId, this.identity.publicKey, pub);
    const peer: Peer = { identity: msg.id, publicKey: pub, displayName: msg.nm, wrapKey };
    this.peerMap.set(msg.id, peer);
    return peer;
  }

  removePeer(identity: string): boolean {
    return this.peerMap.delete(identity);
  }

  /** Fresh random sender key. Used at start and after anyone leaves. */
  startSenderKey(): void {
    this.senderMaterial = randomBytes(MEDIA_KEY_BYTES);
    this.senderKeyIndex = 0;
    this.started = true;
  }

  /**
   * New random key at the next keyring slot. Used when a participant LEAVES:
   * the departing participant holds the old key and must not be able to derive
   * the new one, so this must be random, not a ratchet.
   */
  rotateSenderKey(): void {
    if (!this.started) return this.startSenderKey();
    this.senderMaterial = randomBytes(MEDIA_KEY_BYTES);
    this.senderKeyIndex = (this.senderKeyIndex + 1) % KEYRING_SIZE;
  }

  /**
   * One-way ratchet to the next keyring slot. Used when a participant JOINS:
   * existing members can derive it locally, and the joiner — who only ever
   * receives the post-ratchet value — cannot walk backwards to earlier media.
   */
  ratchetSenderKey(): void {
    if (!this.started) return this.startSenderKey();
    this.senderMaterial = ratchetMaterial(this.senderMaterial);
    this.senderKeyIndex = (this.senderKeyIndex + 1) % KEYRING_SIZE;
  }

  /**
   * Adopt a specific key at a specific slot. Used when re-deriving locally
   * (every member ratchets in lockstep on join) rather than trusting a
   * received value.
   */
  adoptSenderKey(material: Uint8Array, keyIndex: number): void {
    if (material.length !== MEDIA_KEY_BYTES) {
      throw new Error(`key material must be ${MEDIA_KEY_BYTES} bytes`);
    }
    if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex >= KEYRING_SIZE) {
      throw new Error('key index outside the keyring');
    }
    this.senderMaterial = Uint8Array.from(material);
    this.senderKeyIndex = keyIndex;
    this.started = true;
  }

  advance(reason: RotationReason): void {
    if (reason === 'init') this.startSenderKey();
    else if (reason === 'leave') this.rotateSenderKey();
    else this.ratchetSenderKey();
  }

  /** Additional authenticated data binds an envelope to room, sender, recipient and slot. */
  private aad(from: string, to: string, keyIndex: number): Uint8Array {
    return concat(
      utf8('veil/v1/keywrap'),
      lp(this.roomSecret.roomId),
      lp(from),
      lp(to),
      new Uint8Array([keyIndex & 0xff]),
    );
  }

  /** Wrap our current sender key for one peer. */
  async sealFor(peerIdentity: string): Promise<KeyEnvelope> {
    const peer = this.peerMap.get(peerIdentity);
    if (!peer) throw new Error(`no verified peer ${peerIdentity}`);
    if (!this.started) throw new Error('sender key not initialised');
    const nonce = randomBytes(NONCE_BYTES);
    const ct = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce as unknown as ArrayBuffer,
        additionalData: this.aad(this.selfIdentity, peerIdentity, this.senderKeyIndex) as unknown as ArrayBuffer,
      },
      peer.wrapKey,
      this.senderMaterial as unknown as ArrayBuffer,
    );
    return {
      v: WIRE_VERSION,
      t: 'key',
      id: this.selfIdentity,
      to: peerIdentity,
      ki: this.senderKeyIndex,
      n: toB64Url(nonce),
      ct: toB64Url(new Uint8Array(ct)),
    };
  }

  /** Wrap our current sender key for every verified peer. */
  async sealForAll(): Promise<KeyEnvelope[]> {
    return Promise.all(this.peerIdentities.map((id) => this.sealFor(id)));
  }

  /**
   * Unwrap a peer's sender key. Returns null unless the envelope is addressed
   * to us, from a MAC-verified peer, and authenticates under the pairwise key.
   */
  async open(env: KeyEnvelope): Promise<ReceivedKey | null> {
    if (env.to !== this.selfIdentity) return null;
    const peer = this.peerMap.get(env.id);
    if (!peer) return null;
    let nonce: Uint8Array;
    let ct: Uint8Array;
    try {
      nonce = fromB64Url(env.n);
      ct = fromB64Url(env.ct);
    } catch {
      return null;
    }
    if (nonce.length !== NONCE_BYTES) return null;
    try {
      const pt = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce as unknown as ArrayBuffer,
          additionalData: this.aad(env.id, this.selfIdentity, env.ki) as unknown as ArrayBuffer,
        },
        peer.wrapKey,
        ct as unknown as ArrayBuffer,
      );
      const material = new Uint8Array(pt);
      if (material.length !== MEDIA_KEY_BYTES) return null;
      return { from: env.id, keyIndex: env.ki, material };
    } catch {
      return null;
    }
  }
}
