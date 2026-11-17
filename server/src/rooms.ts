/**
 * In-memory room registry: who was admitted, who the host is, whether the room
 * is locked. Nothing here is persisted, and nothing here is a cryptographic
 * secret — the host key only authorises moderation calls to this server. It
 * cannot decrypt anything.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface RoomRecord {
  /** SHA-256 of the host key presented when the room was first created. */
  hostHash?: Buffer;
  hostIdentities: Set<string>;
  locked: boolean;
  /** Identities that were issued a token. Only these may use the key relay. */
  admitted: Set<string>;
  touchedAt: number;
}

const HOST_KEY = /^[A-Za-z0-9_-]{22,64}$/;

function digest(hostKey: string): Buffer {
  return createHash('sha256').update(`bravetalk/host/${hostKey}`).digest();
}

export class RoomRegistry {
  private rooms = new Map<string, RoomRecord>();

  get(roomId: string): RoomRecord | undefined {
    return this.rooms.get(roomId);
  }

  ensure(roomId: string): RoomRecord {
    let rec = this.rooms.get(roomId);
    if (!rec) {
      rec = { hostIdentities: new Set(), locked: false, admitted: new Set(), touchedAt: Date.now() };
      this.rooms.set(roomId, rec);
    }
    rec.touchedAt = Date.now();
    return rec;
  }

  static validHostKey(value: unknown): value is string {
    return typeof value === 'string' && HOST_KEY.test(value);
  }

  /**
   * The first client to create a room may register a host key. Later callers
   * are hosts only if they present the same key.
   */
  claimOrVerifyHost(roomId: string, hostKey: string, roomIsNew: boolean): boolean {
    const rec = this.ensure(roomId);
    const presented = digest(hostKey);
    if (!rec.hostHash) {
      if (!roomIsNew) return false;
      rec.hostHash = presented;
      return true;
    }
    return timingSafeEqual(rec.hostHash, presented);
  }

  isHostKey(roomId: string, hostKey: string): boolean {
    const rec = this.rooms.get(roomId);
    if (!rec?.hostHash) return false;
    return timingSafeEqual(rec.hostHash, digest(hostKey));
  }

  isAdmitted(roomId: string, identity: string): boolean {
    return this.rooms.get(roomId)?.admitted.has(identity) ?? false;
  }

  /** Drop records for rooms LiveKit no longer has. */
  sweep(liveRoomIds: Set<string>, graceMs: number, now = Date.now()): void {
    for (const [id, rec] of this.rooms) {
      if (!liveRoomIds.has(id) && now - rec.touchedAt > graceMs) this.rooms.delete(id);
    }
  }

  get size(): number {
    return this.rooms.size;
  }
}
