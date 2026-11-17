/**
 * Bridge between Veil's key agreement and LiveKit's frame cryptor.
 *
 * LiveKit's BaseKeyProvider keeps a 16-slot keyring per participant. We push
 * keys into it; it HKDFs each one down to the AES-GCM key the worker uses on
 * encoded frames. Old slots are deliberately left populated: a screen share
 * at 15 fps may not emit a keyframe for seconds after a rotation, and Chrome
 * ships Encoded Transform without generateKeyFrame(), so we cannot force one.
 * Keeping the previous keys decryptable is what stops a rekey from blacking
 * out the share.
 */
import { BaseKeyProvider, createKeyMaterialFromBuffer } from 'livekit-client';
import { KEYRING_SIZE } from '../crypto/group.ts';

export class VeilKeyProvider extends BaseKeyProvider {
  constructor() {
    super({
      // Per-participant keys, not one shared passphrase.
      sharedKey: false,
      keyringSize: KEYRING_SIZE,
      // Auto-ratchet forward on decryption failure, within a window.
      ratchetWindowSize: 8,
      failureTolerance: 10,
      // 128 is the only width non-web LiveKit SDKs support; stay compatible.
      keySize: 128,
      ratchetSalt: 'veil/v1/frame',
    });
  }

  /**
   * Install a participant's media key at a keyring slot.
   * `identity` must be the LiveKit participant identity, including our own for
   * the encryption side.
   */
  async setParticipantKey(
    material: Uint8Array,
    identity: string,
    keyIndex: number,
  ): Promise<void> {
    if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex >= KEYRING_SIZE) {
      throw new Error(`key index ${keyIndex} outside keyring`);
    }
    const copy = Uint8Array.from(material);
    const keyMaterial = await createKeyMaterialFromBuffer(
      copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
    );
    this.onSetEncryptionKey(keyMaterial, identity, keyIndex);
  }
}
