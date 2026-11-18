import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Hand, Pause, Play, Volume2, VolumeX, X } from 'lucide-preact';
import { formatDuration } from '../../app/util.ts';
import type { FileShow, RoomSession } from '../../call/session.ts';
import { useTicker } from '../components/hooks.ts';
import { IconButton, Slider } from '../components/primitives.tsx';
import { ControlPicker, controlText, usePauseOrAsk } from './OwnPlayer.tsx';

/**
 * Play, pause and skip for a file someone is playing for the room. The same
 * bar appears for everyone, and everyone's buttons work.
 */
export function SharedBar(props: { session: RoomSession; show: FileShow; children?: preact.ComponentChildren }) {
  const { session, show } = props;
  const isHost = show.host === session.identity;
  const [scrub, setScrub] = useState<number | null>(null);
  useTicker(500, show.playing);
  const live = show.playing ? show.position + (Date.now() - show.at) / 1000 : show.position;
  const position = Math.min(scrub ?? live, show.duration || Infinity);
  const { canPause, canOther, asked, ask } = usePauseOrAsk(session);

  return (
    <div class="movie-bar" onPointerDown={(e) => e.stopPropagation()} data-testid="shared-bar">
      <IconButton
        label={show.playing ? (canPause ? 'Pause for everyone' : asked ? 'Asked the host' : 'Ask the host to pause') : canOther ? 'Play for everyone' : 'Only the host can press play'}
        onClick={() => (show.playing && !canPause ? ask() : session.fileCommand({ action: show.playing ? 'pause' : 'play' }))}
        disabled={show.playing ? asked : !canOther}
        data-testid="shared-toggle"
      >
        {show.playing ? canPause ? <Pause /> : <Hand /> : <Play />}
      </IconButton>
      <span class="mono movie-time" data-testid="shared-time">
        {formatDuration(position)}
      </span>
      <Slider
        label="Skip for everyone"
        disabled={!canOther}
        min={0}
        max={Math.max(1, show.duration)}
        step={0.5}
        value={Math.min(position, Math.max(1, show.duration))}
        onInput={setScrub}
        onCommit={(v) => {
          setScrub(null);
          session.fileCommand({ action: 'seek', position: v });
        }}
      />
      <span class="mono movie-time">{show.duration ? formatDuration(show.duration) : '–:––'}</span>
      {props.children}
      <ControlPicker session={session} />
      {isHost && (
        <IconButton label="Stop for everyone" onClick={() => void session.stopFileShow()} data-testid="file-stop">
          <X />
        </IconButton>
      )}
    </div>
  );
}

type Capturable = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

/**
 * The player on the device that owns the file. It plays the file locally and
 * streams what it plays to the room; commands from anyone land here.
 */
export function FileHostPlayer(props: { session: RoomSession; children?: preact.ComponentChildren }) {
  const { session } = props;
  const file = session.localFile.value!;
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState<string | undefined>();
  const [muted, setMuted] = useState(false);
  const show = session.fileShow.value;

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  useEffect(() => {
    const v = ref.current as Capturable | null;
    if (!v) return;
    let started = false;
    const report = () =>
      session.publishFileState({ playing: !v.paused && !v.ended, position: v.currentTime, duration: v.duration || 0 });

    const onReady = () => {
      if (started) return;
      started = true;
      try {
        const capture = (v.captureStream ?? v.mozCaptureStream)!.call(v);
        void session.startFileShow(capture).then(() => v.play().catch(() => undefined));
      } catch (err) {
        setFailed(`This browser could not stream the file: ${err instanceof Error ? err.message : String(err)}`);
      }
      report();
    };
    const onError = () =>
      setFailed('This browser cannot play that file. MP4 (H.264) and WebM work almost everywhere; MKV and HEVC often do not.');

    session.onFileCommand = (cmd) => {
      if (cmd.action === 'play') void v.play().catch(() => undefined);
      else if (cmd.action === 'pause') v.pause();
      else if (cmd.action === 'seek') v.currentTime = Math.min(cmd.position, v.duration || cmd.position);
    };

    v.addEventListener('loadedmetadata', onReady);
    v.addEventListener('error', onError);
    for (const ev of ['play', 'pause', 'seeked', 'ended'] as const) v.addEventListener(ev, report);
    const t = setInterval(report, 1000);
    return () => {
      clearInterval(t);
      session.onFileCommand = undefined;
      v.removeEventListener('loadedmetadata', onReady);
      v.removeEventListener('error', onError);
      for (const ev of ['play', 'pause', 'seeked', 'ended'] as const) v.removeEventListener(ev, report);
    };
  }, [url]);

  return (
    <div class="content-tile movie" data-flip="file" data-testid="file-host">
      <video
        ref={ref}
        src={url}
        playsInline
        preload="auto"
        muted={muted}
        onClick={() => show && session.fileCommand({ action: show.playing ? 'pause' : 'play' })}
        data-testid="file-video"
      />
      {failed && (
        <div class="movie-msg" role="alert">
          <strong>That file could not be played</strong>
          <span>{failed}</span>
          <button type="button" class="btn btn-sm" style={{ marginTop: '10px' }} onClick={() => void session.stopFileShow()}>
            Close
          </button>
        </div>
      )}
      <div class="content-chip live">
        <span class="live-dot" />
        You are playing {file.name} · {controlText(session.controlLevel.value)}
      </div>
      {show && (
        <SharedBar session={session} show={show}>
          <IconButton label={muted ? 'Unmute for me' : 'Mute for me'} onClick={() => setMuted(!muted)}>
            {muted ? <VolumeX /> : <Volume2 />}
          </IconButton>
        </SharedBar>
      )}
      {props.children}
    </div>
  );
}
