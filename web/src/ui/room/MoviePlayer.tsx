import { useEffect, useRef, useState } from 'preact/hooks';
import { Pause, Play, Volume2, VolumeX, X } from 'lucide-preact';
import { formatDuration } from '../../app/util.ts';
import type { RoomSession } from '../../call/session.ts';
import { expectedPosition, planCorrection } from '../../movie/sync.ts';
import { IconButton, Slider } from '../components/primitives.tsx';

/**
 * Synchronised playback of a direct video link. Each person loads the file
 * themselves; BraveTalk shares only play, pause and position, and nudges each
 * player back into line when it drifts.
 */
export function MoviePlayer(props: { session: RoomSession; children?: preact.ComponentChildren }) {
  const { session } = props;
  const state = session.movie.value;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const deafened = session.deafened.value;

  // Adopt shared state: position, then play or pause.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !state) return;
    const target = expectedPosition(state, Date.now());
    if (Math.abs(v.currentTime - target) > 0.4) v.currentTime = target;
    if (state.playing) {
      v.play().then(
        () => setBlocked(false),
        () => setBlocked(true),
      );
    } else {
      v.pause();
    }
  }, [state?.rev, state?.url]);

  // Drift correction, once a second.
  useEffect(() => {
    const t = setInterval(() => {
      const v = videoRef.current;
      const held = session.movie.peek();
      if (!v || !held || v.readyState < 2) return;
      setPosition(v.currentTime);
      const plan = planCorrection(expectedPosition(held, Date.now()), v.currentTime, held.playing && !v.paused);
      if (plan.kind === 'seek') {
        v.currentTime = plan.to;
        setSyncing(true);
      } else if (plan.kind === 'rate') {
        v.playbackRate = plan.rate;
        setSyncing(plan.rate !== 1);
      } else {
        setSyncing(false);
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted || deafened;
  }, [volume, muted, deafened]);

  useEffect(() => setFailed(false), [state?.url]);

  if (!state) return null;
  const shown = scrubbing ?? position;

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    session.setMovie({ playing: !state.playing, position: v.currentTime });
  };

  return (
    <div class="content-tile movie" data-flip="movie" data-testid="movie">
      <video
        ref={videoRef}
        src={state.url}
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration || 0)}
        onError={() => setFailed(true)}
        onClick={toggle}
        data-testid="movie-video"
      />

      {failed && (
        <div class="movie-msg">
          <strong>This link could not be played</strong>
          <span>
            It may not point directly at a video file, or the site may not allow it to be played
            from another page. Share a tab instead and everyone will see it.
          </span>
        </div>
      )}
      {blocked && !failed && (
        <button
          type="button"
          class="movie-msg clickable"
          onClick={() => videoRef.current?.play().then(() => setBlocked(false), () => undefined)}
        >
          <Play />
          <strong>Click to start playback</strong>
          <span>Your browser needs one click before it will play video with sound.</span>
        </button>
      )}

      <div class="content-chip">
        <span class="sync-dot" data-syncing={syncing} />
        Watching together · anyone can pause · {syncing ? 'catching up' : 'in sync'}
      </div>

      <div class="movie-bar" onPointerDown={(e) => e.stopPropagation()}>
        <IconButton label={state.playing ? 'Pause for everyone' : 'Play for everyone'} onClick={toggle} data-testid="movie-toggle">
          {state.playing ? <Pause /> : <Play />}
        </IconButton>
        <span class="mono movie-time">{formatDuration(shown)}</span>
        <Slider
          label="Seek for everyone"
          min={0}
          max={Math.max(1, duration)}
          step={0.1}
          value={Math.min(shown, Math.max(1, duration))}
          onInput={(v) => setScrubbing(v)}
          onCommit={(v) => {
            setScrubbing(null);
            setPosition(v);
            session.setMovie({ position: v });
          }}
        />
        <span class="mono movie-time">{duration ? formatDuration(duration) : '–:––'}</span>
        <IconButton
          label={deafened ? 'Silenced while deafened' : muted ? 'Unmute video' : 'Mute video for me'}
          onClick={() => setMuted(!muted)}
          disabled={deafened}
        >
          {muted || deafened ? <VolumeX /> : <Volume2 />}
        </IconButton>
        <div class="movie-vol">
          <Slider label="Video volume for me" value={muted ? 0 : volume} onInput={(v) => { setVolume(v); setMuted(false); }} />
        </div>
        <IconButton label="Stop for everyone" onClick={() => session.setMovie(null)} data-testid="movie-close">
          <X />
        </IconButton>
      </div>
      {props.children}
    </div>
  );
}
