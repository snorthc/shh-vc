import { useMemo, useState } from 'preact/hooks';
import { Bookmark, Check, Hand, Pause, Play, Redo2, Undo2, X } from 'lucide-preact';
import { FROM_FILE } from '../../app/mode.ts';
import { toast } from '../../app/toasts.ts';
import { formatDuration } from '../../app/util.ts';
import type { RoomSession } from '../../call/session.ts';
import { bookmarkletHref } from '../../movie/bookmarklet.ts';
import { CONTROL_LEVELS, type ControlLevel, LEVEL_LABEL } from '../../movie/control.ts';
import { COUNTDOWN_SECONDS, countInLeft, expectedPosition, parseClock } from '../../movie/sync.ts';
import { useTicker } from '../components/hooks.ts';
import { Button, IconButton } from '../components/primitives.tsx';

/** What everyone sees about the rule in force. */
export function controlText(level: ControlLevel): string {
  return level === 'everyone' ? 'anyone can pause' : level === 'pause' ? 'anyone can pause · host skips' : 'host controls playback';
}

/** The host's choice of who controls playback. Nothing for anyone else. */
export function ControlPicker(props: { session: RoomSession }) {
  const { session } = props;
  if (!session.controlHost) return null;
  return (
    <label class="control-picker" onPointerDown={(e) => e.stopPropagation()}>
      <span class="sr-only">Who can control what we are watching</span>
      <select
        class="select"
        value={session.controlPolicy.value}
        onChange={(e) => session.setControlPolicy((e.target as HTMLSelectElement).value as ControlLevel)}
        data-testid="control-level"
        title="Who can control what we are watching"
      >
        {CONTROL_LEVELS.map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABEL[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A pause button that becomes "Ask to pause" when the host has the say. */
export function usePauseOrAsk(session: RoomSession): { canPause: boolean; canOther: boolean; asked: boolean; ask: () => void } {
  const [asked, setAsked] = useState(false);
  return {
    canPause: session.allowed('pause'),
    canOther: session.allowed('other'),
    asked,
    ask: () => {
      if (session.nudge('pause')) {
        setAsked(true);
        setTimeout(() => setAsked(false), 4000);
      }
    },
  };
}

function linkUrl(): string {
  return new URL('link.html', location.origin + location.pathname).href;
}

/** How to set up the bookmarklet that syncs a Netflix tab automatically. */
export function SyncSetup() {
  const href = useMemo(() => bookmarkletHref(linkUrl()), []);
  if (FROM_FILE) return null;
  return (
    <div class="sync-setup" data-testid="sync-setup">
      <a
        class="bookmarklet"
        href={href}
        draggable
        onClick={(e) => {
          e.preventDefault();
          toast('Drag this button to your bookmarks bar', 'info', 'Then click the bookmark while Netflix is open in another tab.');
        }}
        data-testid="bookmarklet"
      >
        <Bookmark />
        Shh VC Sync
      </a>
      <ol class="sync-steps">
        <li>Drag <strong>Shh VC Sync</strong> to your bookmarks bar. No bar? Press Ctrl+Shift+B, or ⌘+Shift+B on a Mac.</li>
        <li>Open Netflix in another tab of this browser and start the episode.</li>
        <li>Click the bookmark. A small Shh VC window opens: keep it open while you watch.</li>
      </ol>
      <p class="hint">
        Works in Chrome, Edge, Brave, Firefox and Safari on a computer. On a phone or TV, follow the
        clock instead. Each person needs their own Netflix.
      </p>
    </div>
  );
}

/**
 * The shared clock for something everyone plays on their own device and
 * account. People on a computer can link their Netflix tab and it follows
 * automatically; everyone else matches the clock by hand.
 */
export function OwnPlayer(props: { session: RoomSession }) {
  const { session } = props;
  const state = session.movie.value;
  const linked = session.link.linked.value;
  const status = session.link.status.value;
  const level = session.controlLevel.value;
  const { canPause, canOther, asked, ask } = usePauseOrAsk(session);
  const [jump, setJump] = useState('');
  const [setup, setSetup] = useState(false);
  useTicker(250, !!state?.playing);
  if (!state) return null;

  const now = Date.now();
  const left = countInLeft(state, now);
  const position = Math.max(0, expectedPosition(state, now));
  const skip = (by: number) => session.setMovie({ position: Math.max(0, position + by) });

  return (
    <div class="content-tile own" data-flip="movie" data-testid="own">
      <div class="own-inner">
        <p class="own-eyebrow">On everyone’s own account</p>
        <h2 class="own-title" data-testid="own-title">{state.title || 'Watching together'}</h2>
        <div class="own-clock mono" aria-live="off" data-testid="own-clock" data-counting={left > 0}>
          {left > 0 ? Math.ceil(left) : formatDuration(position)}
        </div>
        <p class="own-state" data-testid="own-state">
          {left > 0
            ? 'Get ready to press play'
            : state.playing
              ? 'Playing'
              : 'Paused — match this time on your device'}
        </p>

        <div class="own-controls" onPointerDown={(e) => e.stopPropagation()}>
          <IconButton label="Back 10 seconds for everyone" disabled={!canOther} onClick={() => skip(-10)}>
            <Undo2 />
          </IconButton>
          {state.playing ? (
            canPause ? (
              <Button variant="primary" onClick={() => session.setMovie({ playing: false, position })} data-testid="own-toggle">
                <Pause />
                Pause for everyone
              </Button>
            ) : (
              <Button disabled={asked} onClick={ask} data-testid="own-ask">
                <Hand />
                {asked ? 'Asked the host' : 'Ask to pause'}
              </Button>
            )
          ) : (
            <Button
              variant="primary"
              disabled={!canOther}
              data-tip={canOther ? undefined : 'Only the host can press play'}
              onClick={() => session.setMovie({ playing: true, position, countIn: COUNTDOWN_SECONDS })}
              data-testid="own-toggle"
            >
              <Play />
              Play in {COUNTDOWN_SECONDS}
            </Button>
          )}
          <IconButton label="Forward 10 seconds for everyone" disabled={!canOther} onClick={() => skip(10)}>
            <Redo2 />
          </IconButton>
          <form
            class="own-jump"
            onSubmit={(e) => {
              e.preventDefault();
              const to = parseClock(jump);
              if (to === undefined) {
                toast('Type a time like 12:30 or 1:02:03', 'warn');
                return;
              }
              if (session.setMovie({ position: to })) setJump('');
            }}
          >
            <input
              class="input mono"
              inputMode="numeric"
              placeholder="12:30"
              aria-label="Jump everyone to a time"
              value={jump}
              disabled={!canOther}
              onInput={(e) => setJump((e.target as HTMLInputElement).value)}
              data-testid="own-jump"
            />
            <Button type="submit" size="sm" disabled={!canOther}>
              Jump
            </Button>
          </form>
        </div>

        {status?.kind === 'go' && linked && (
          <div class="own-note warn" data-testid="own-go">
            <span>Your Netflix tab is on a different episode.</span>
            <Button size="sm" onClick={() => session.link.goThere(status.watch)}>
              Go there
            </Button>
          </div>
        )}
        {linked && status?.kind !== 'go' ? (
          <p class="own-note ok" data-testid="own-linked">
            <Check />
            Your {linked.site.includes('netflix') ? 'Netflix' : 'video'} tab is linked and follows automatically.
          </p>
        ) : (
          !linked && !FROM_FILE && (
            <div class="own-setup">
              <button type="button" class="link-btn" aria-expanded={setup} onClick={() => setSetup(!setup)} data-testid="own-setup-toggle">
                {setup ? 'Hide' : 'On a computer? Sync your Netflix tab automatically'}
              </button>
              {setup && <SyncSetup />}
            </div>
          )
        )}
      </div>

      <div class="content-chip">Watching together · {controlText(level)}</div>
      <div class="own-corner" onPointerDown={(e) => e.stopPropagation()}>
        <ControlPicker session={session} />
        {canOther && (
          <IconButton label="Stop for everyone" tipPos="left" onClick={() => session.setMovie(null)} data-testid="movie-close">
            <X />
          </IconButton>
        )}
      </div>
    </div>
  );
}
