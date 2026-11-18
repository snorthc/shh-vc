/**
 * Watch-together playback sync.
 *
 * This only applies to a video Shh VC plays itself: a direct link to a
 * media file that every participant loads in their own browser. Play, pause
 * and seek are shared over the encrypted data channel and each client corrects
 * its own drift. It cannot control Netflix, YouTube or any other site's
 * player — for those, share a tab instead.
 */

export interface MovieState {
  url: string;
  playing: boolean;
  /** Seconds into the video at the moment the state was produced. */
  position: number;
  /** Monotonic revision; higher wins. */
  rev: number;
  /** Identity of whoever made the change. */
  by: string;
  /** 'own': everyone plays it on their own device and account (Netflix, a TV). */
  kind?: 'own';
  /** What is on, as typed by a person or read from their Netflix tab. */
  title?: string;
  /** Netflix's id for the episode, so a linked tab can tell it is on the same one. */
  watch?: string;
  /** Seconds of count-in before the clock starts moving, so people on TVs press play together. */
  countIn?: number;
}

export interface HeldState extends MovieState {
  /** Local clock (ms) when we adopted this state. */
  receivedAt: number;
}

/** Where playback should be right now, given a held state. */
export function expectedPosition(state: HeldState, now: number): number {
  if (!state.playing) return state.position;
  return state.position + Math.max(0, (now - state.receivedAt) / 1000 - (state.countIn ?? 0));
}

/** Seconds left in the count-in, or 0 once the clock is running. */
export function countInLeft(state: HeldState, now: number): number {
  if (!state.playing || !state.countIn) return 0;
  return Math.max(0, state.countIn - (now - state.receivedAt) / 1000);
}

/** Adopt `incoming` only if it is newer; ties break on the author's identity. */
export function shouldAdopt(current: MovieState | undefined, incoming: MovieState): boolean {
  if (!current) return true;
  if (incoming.rev !== current.rev) return incoming.rev > current.rev;
  return incoming.by > current.by;
}

export type Correction =
  | { kind: 'none' }
  | { kind: 'seek'; to: number }
  | { kind: 'rate'; rate: number };

export const SEEK_THRESHOLD = 0.75;
export const NUDGE_THRESHOLD = 0.08;

/**
 * Decide how to pull local playback back in line. Small errors are corrected
 * by playing very slightly faster or slower, which is inaudible; large ones
 * by seeking.
 */
export function planCorrection(expected: number, actual: number, playing: boolean): Correction {
  const error = expected - actual;
  const magnitude = Math.abs(error);
  if (!playing) {
    return magnitude > 0.05 ? { kind: 'seek', to: expected } : { kind: 'none' };
  }
  if (magnitude > SEEK_THRESHOLD) return { kind: 'seek', to: expected };
  if (magnitude > NUDGE_THRESHOLD) return { kind: 'rate', rate: error > 0 ? 1.06 : 0.94 };
  return { kind: 'rate', rate: 1 };
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** Validate a link before offering it to the room. */
export function checkMovieUrl(input: string, pageIsHttps: boolean): UrlCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'Paste a link to a video file.' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'That is not a valid link.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http and https links can be played.' };
  }
  if (pageIsHttps && url.protocol === 'http:') {
    return { ok: false, reason: 'Browsers block http video on an https page. Use an https link.' };
  }
  if (/(^|\.)(youtube\.com|youtu\.be|netflix\.com|primevideo\.com|disneyplus\.com|twitch\.tv|hulu\.com|max\.com)$/i.test(url.hostname)) {
    return {
      ok: false,
      reason:
        'Shh VC can’t play that site itself. Choose “On everyone’s own account” to sync it, or share the tab.',
    };
  }
  return { ok: true, url: url.toString() };
}

/** Linked players further apart than this are jumped back in line. */
export const OWN_RESYNC_SECONDS = 1.5;
/** Pressing play on the shared clock counts everyone in. */
export const COUNTDOWN_SECONDS = 3;

/** "1:02:03", "12:30", "90" → seconds; undefined when it is not a time. */
export function parseClock(input: string): number | undefined {
  const parts = input.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d{1,3}$/.test(p))) return undefined;
  const n = parts.map(Number);
  if (n.slice(1).some((v) => v >= 60)) return undefined;
  return n.reduce((acc, v) => acc * 60 + v, 0);
}
