/**
 * Interface sounds, synthesised with the Web Audio API. There are no audio
 * files: every sound is a couple of short enveloped sine tones, so the set is
 * original, tiny, and consistent.
 *
 * Browsers refuse to play audio before a user gesture. `unlockAudio()` is
 * called from the first pointer or key event; until then, play() is a no-op
 * rather than an error.
 */
import { settings } from '../app/settings.ts';

export type SoundName =
  | 'join'
  | 'leave'
  | 'peerJoin'
  | 'peerLeave'
  | 'send'
  | 'receive'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'shareStart'
  | 'shareStop'
  | 'notify'
  | 'success'
  | 'error';

interface Note {
  /** Hz */
  f: number;
  /** Start offset, seconds. */
  at: number;
  /** Duration, seconds. */
  d: number;
  /** Relative level 0–1. */
  g?: number;
  /** Glide to this frequency over the note. */
  to?: number;
}

// A pentatonic-ish family around D so everything sounds related.
const D4 = 293.66;
const A4 = 440;
const D5 = 587.33;
const E5 = 659.25;
const A5 = 880;
const F5s = 739.99;

const SOUNDS: Record<SoundName, Note[]> = {
  join: [
    { f: D5, at: 0, d: 0.11 },
    { f: A5, at: 0.09, d: 0.16 },
  ],
  leave: [
    { f: A5, at: 0, d: 0.11 },
    { f: D5, at: 0.09, d: 0.18 },
  ],
  peerJoin: [{ f: E5, at: 0, d: 0.12, g: 0.7, to: F5s }],
  peerLeave: [{ f: E5, at: 0, d: 0.14, g: 0.6, to: D5 }],
  send: [{ f: A5, at: 0, d: 0.05, g: 0.45, to: 1046.5 }],
  receive: [{ f: F5s, at: 0, d: 0.07, g: 0.55 }],
  mute: [{ f: A4, at: 0, d: 0.07, g: 0.8, to: D4 * 1.2 }],
  unmute: [{ f: A4, at: 0, d: 0.07, g: 0.8, to: D5 }],
  deafen: [
    { f: D5, at: 0, d: 0.08, g: 0.75 },
    { f: D4, at: 0.07, d: 0.14, g: 0.75 },
  ],
  undeafen: [
    { f: D4, at: 0, d: 0.08, g: 0.75 },
    { f: D5, at: 0.07, d: 0.14, g: 0.75 },
  ],
  shareStart: [
    { f: D5, at: 0, d: 0.08 },
    { f: F5s, at: 0.07, d: 0.08 },
    { f: A5, at: 0.14, d: 0.18 },
  ],
  shareStop: [
    { f: A5, at: 0, d: 0.08 },
    { f: D5, at: 0.08, d: 0.18 },
  ],
  notify: [
    { f: F5s, at: 0, d: 0.09 },
    { f: F5s, at: 0.13, d: 0.12 },
  ],
  success: [
    { f: A4, at: 0, d: 0.07 },
    { f: E5, at: 0.06, d: 0.15 },
  ],
  error: [
    { f: 220, at: 0, d: 0.1, g: 0.9 },
    { f: 196, at: 0.12, d: 0.16, g: 0.9 },
  ],
};

let ctx: AudioContext | undefined;
let unlocked = false;

/** Counts sounds actually scheduled, so tests can verify settings are honoured. */
export const sfxDebug = { played: 0, lastGain: 0 };

export function unlockAudio(): void {
  if (unlocked) return;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    ctx = new Ctor();
    void ctx.resume();
    unlocked = true;
  } catch {
    ctx = undefined;
  }
}

if (typeof window !== 'undefined') {
  const once = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', once, true);
    window.removeEventListener('keydown', once, true);
  };
  window.addEventListener('pointerdown', once, true);
  window.addEventListener('keydown', once, true);
  (window as unknown as { __sfx?: typeof sfxDebug }).__sfx = sfxDebug;
}

export function play(name: SoundName): void {
  const { sfxEnabled, sfxVolume } = settings.value;
  if (!sfxEnabled || sfxVolume <= 0 || !ctx || !unlocked) return;
  if (ctx.state === 'suspended') void ctx.resume();

  const master = ctx.createGain();
  // Deliberately quiet: these sit under a conversation.
  const level = 0.16 * sfxVolume;
  master.gain.value = level;
  master.connect(ctx.destination);
  const now = ctx.currentTime + 0.005;

  for (const note of SOUNDS[name]) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    const start = now + note.at;
    const end = start + note.d;
    osc.frequency.setValueAtTime(note.f, start);
    if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, end);
    const peak = note.g ?? 1;
    // Fast attack, exponential release: a soft "tick", never a click.
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, end + 0.06);
    osc.connect(env);
    env.connect(master);
    osc.start(start);
    osc.stop(end + 0.08);
  }
  sfxDebug.played++;
  sfxDebug.lastGain = level;
  setTimeout(() => master.disconnect(), 900);
}
