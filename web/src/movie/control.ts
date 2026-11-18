/**
 * Who may control what the room is watching.
 *
 * The room creator holds a host key (in their address bar only). From it we
 * derive an Ed25519 signing key; its public half rides in the invite link.
 * The host signs the rule and their own playback commands, and every device
 * refuses commands that break the rule. Nobody can force another person's
 * player — a modified app can only misbehave on its own device.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { concat, fromB64Url, toB64Url, utf8 } from '../crypto/bytes.ts';
import { expectedPosition, type HeldState, type MovieState } from './sync.ts';

export type ControlLevel = 'everyone' | 'pause' | 'host';
export const CONTROL_LEVELS: ControlLevel[] = ['everyone', 'pause', 'host'];
/** After the host has been gone this long, control opens to everyone. */
export const HOST_GRACE_MS = 30_000;
export const POLICY_INTERVAL_MS = 10_000;

export interface Policy {
  level: ControlLevel;
  rev: number;
}

export function isLevel(v: unknown): v is ControlLevel {
  return v === 'everyone' || v === 'pause' || v === 'host';
}

export function hostSeed(hostKey: string): Uint8Array {
  return sha256(concat(utf8('shh-vc/v1/host-sign'), fromB64Url(hostKey)));
}

export function hostPublicKey(seed: Uint8Array): string {
  return toB64Url(ed25519.getPublicKey(seed));
}

function signedBytes(roomId: string, payload: unknown): Uint8Array {
  return utf8(`shh-vc/v1/host|${roomId}|${JSON.stringify(payload)}`);
}

export function signAsHost(seed: Uint8Array, roomId: string, payload: unknown): string {
  return toB64Url(ed25519.sign(signedBytes(roomId, payload), seed));
}

export function verifyHost(pub: string, roomId: string, payload: unknown, sig: unknown): boolean {
  if (typeof sig !== 'string' || sig.length > 100) return false;
  try {
    return ed25519.verify(fromB64Url(sig), signedBytes(roomId, payload), fromB64Url(pub));
  } catch {
    return false;
  }
}

/** The rule in force: a host who has gone quiet no longer holds the room back. */
export function effectiveLevel(level: ControlLevel, hostSeenAt: number, now: number, iAmHost: boolean): ControlLevel {
  if (iAmHost) return level;
  return now - hostSeenAt < HOST_GRACE_MS ? level : 'everyone';
}

export type Change = 'pause' | 'other';

export function mayChange(level: ControlLevel, fromHost: boolean, change: Change): boolean {
  if (fromHost || level === 'everyone') return true;
  return level === 'pause' && change === 'pause';
}

/** A pause keeps everything as it is except stopping, at about the same moment. */
export function classifyChange(current: HeldState | undefined, next: MovieState, now: number): Change {
  if (!current || next.playing) return 'other';
  const same =
    next.url === current.url &&
    next.kind === current.kind &&
    (next.watch ?? '') === (current.watch ?? '') &&
    (next.title ?? '') === (current.title ?? '');
  if (!same) return 'other';
  return Math.abs(next.position - expectedPosition(current, now)) < 3 ? 'pause' : 'other';
}

export const LEVEL_LABEL: Record<ControlLevel, string> = {
  everyone: 'Everyone',
  pause: 'Everyone can pause, only the host skips',
  host: 'Only the host',
};
