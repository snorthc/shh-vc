/**
 * The room's end of the Netflix link.
 *
 * The bookmarklet runs in the person's Netflix tab and talks to a small Shh VC
 * pop-up (link.html) by postMessage. The pop-up and this room tab share an
 * origin, so they talk over a BroadcastChannel. Nothing here leaves the
 * browser: the room hears only the shared clock, over the encrypted channel.
 */
import { effect, signal } from '@preact/signals';
import { FROM_FILE } from '../app/mode.ts';
import { toast } from '../app/toasts.ts';
import type { RoomSession } from '../call/session.ts';
import { type BridgeStatus, LINK_CHANNEL } from './link-protocol.ts';
import { countInLeft, expectedPosition, type HeldState, OWN_RESYNC_SECONDS } from './sync.ts';

/** How long after an applied command a matching player event is ours, not the person's. */
const QUIET_MS = 2500;
const STALE_MS = 5000;

export interface LinkedPlayer {
  site: string;
  title: string;
  watch?: string;
  playing: boolean;
  position: number;
  seen: number;
}


/** Validates what a player tab sends: it is another site's page, so trust nothing. */
export function readPlayerMessage(d: unknown): (Omit<LinkedPlayer, 'seen'> & { type: 'tick' | 'event' }) | undefined {
  if (typeof d !== 'object' || d === null) return undefined;
  const m = d as Record<string, unknown>;
  if (m.from !== 'player' || (m.type !== 'tick' && m.type !== 'event')) return undefined;
  if (typeof m.playing !== 'boolean' || typeof m.position !== 'number' || !Number.isFinite(m.position)) return undefined;
  if (m.position < 0 || m.position > 86_400) return undefined;
  const watch = typeof m.watch === 'string' && /^\d{1,12}$/.test(m.watch) ? m.watch : undefined;
  return {
    type: m.type,
    site: typeof m.site === 'string' ? m.site.slice(0, 100) : '',
    title: typeof m.title === 'string' ? m.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    playing: m.playing,
    position: m.position,
    ...(watch ? { watch } : {}),
  };
}

export class PlayerLink {
  readonly linked = signal<LinkedPlayer | undefined>(undefined);
  readonly status = signal<BridgeStatus | undefined>(undefined);
  private readonly ch: BroadcastChannel | undefined;
  private quietUntil = 0;
  private prevWatch: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopEffect: (() => void) | undefined;

  constructor(private readonly s: RoomSession) {
    if (FROM_FILE || typeof BroadcastChannel === 'undefined') return;
    this.ch = new BroadcastChannel(LINK_CHANNEL);
    this.ch.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    this.timer = setInterval(() => {
      const l = this.linked.peek();
      if (l && Date.now() - l.seen > STALE_MS) this.linked.value = undefined;
    }, 2000);
    // Whenever the shared clock changes, move the linked player with it.
    this.stopEffect = effect(() => {
      const m = this.s.movie.value;
      if (this.linked.peek() && m?.kind === 'own') this.apply(m);
      this.report();
    });
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stopEffect?.();
    this.ch?.close();
  }

  /** Ask the linked tab to open the episode the room is on. */
  goThere(watch: string): void {
    this.post({ to: 'player', type: 'go', watch });
  }

  private post(msg: object): void {
    this.ch?.postMessage(msg);
  }

  private onMessage(d: unknown): void {
    if (typeof d === 'object' && d !== null && (d as { from?: unknown }).from === 'bridge') {
      this.report();
      return;
    }
    const p = readPlayerMessage(d);
    if (!p) return;
    const now = Date.now();
    const wasLinked = !!this.linked.peek();
    const { type, ...rest } = p;
    this.linked.value = { ...rest, seen: now };

    const m = this.s.movie.peek();
    if (m?.kind !== 'own') {
      // Clicking the bookmark starts a shared clock for this tab, unless something else is on.
      if (!wasLinked && !m && !this.s.fileShow.peek()) {
        this.s.setMovie({ url: 'own', kind: 'own', title: p.title, watch: p.watch, playing: p.playing, position: p.position });
      }
      this.prevWatch = p.watch;
      this.report();
      return;
    }

    if (p.watch && m.watch && p.watch !== m.watch) {
      // Our own player moved on by itself (autoplay, next episode): take the room along.
      const movedOn = this.prevWatch === m.watch;
      this.prevWatch = p.watch;
      if (!(movedOn && this.s.setMovie({ watch: p.watch, title: p.title, playing: p.playing, position: p.position }))) {
        this.report();
      }
      return;
    }
    this.prevWatch = p.watch;
    if (p.watch && !m.watch) this.s.setMovie({ watch: p.watch, title: m.title || p.title });

    const want = this.target(m, now);
    const matches = p.playing === want.playing && Math.abs(p.position - want.position) <= OWN_RESYNC_SECONDS;
    if (type === 'event' && !(now < this.quietUntil && matches)) {
      // The person pressed something on Netflix itself.
      if (!this.s.setMovie({ playing: p.playing, position: p.position })) {
        if (!p.playing) this.s.nudge('pause');
        toast(
          'The host controls playback',
          'info',
          !p.playing ? 'We put your Netflix back and asked the host to pause.' : 'We put your Netflix back in line with the room.',
        );
        this.apply(this.s.movie.peek()!);
      }
      return;
    }
    if (type === 'tick' && now > this.quietUntil && !matches) this.apply(m);
  }

  private target(m: HeldState, now: number): { playing: boolean; position: number } {
    return { playing: m.playing && countInLeft(m, now) === 0, position: Math.max(0, expectedPosition(m, now)) };
  }

  private apply(m: HeldState): void {
    const l = this.linked.peek();
    if (l && m.watch && l.watch && l.watch !== m.watch) return; // a different episode: "Go there" instead
    const now = Date.now();
    this.quietUntil = now + QUIET_MS;
    const left = countInLeft(m, now);
    this.post({ to: 'player', type: 'apply', ...this.target(m, now) });
    // A count-in: start the player when it ends.
    if (left > 0) setTimeout(() => this.s.movie.peek() === m && this.apply(m), left * 1000 + 20);
  }

  private report(): void {
    const m = this.s.movie.peek();
    const l = this.linked.peek();
    let status: BridgeStatus;
    if (m?.kind !== 'own') status = m || this.s.fileShow.peek() ? { kind: 'busy' } : { kind: 'wait' };
    else if (l?.watch && m.watch && l.watch !== m.watch) {
      status = { kind: 'go', watch: m.watch, title: m.title ?? '', who: this.s.nameOf(m.by) };
    } else status = { kind: 'linked', title: m.title || l?.title || '' };
    this.status.value = status;
    this.post({ to: 'bridge', type: 'status', status });
  }
}
