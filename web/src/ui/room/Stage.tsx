import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Activity, Hand, Maximize, Minimize, MonitorUp, RefreshCw, Square } from 'lucide-preact';
import { Track } from 'livekit-client';
import { fitGrid } from '../../app/layout.ts';
import type { LayoutMode } from '../../app/settings.ts';
import type { ParticipantView, RoomSession } from '../../call/session.ts';
import { useFlip } from '../components/hooks.ts';
import { Button, IconButton } from '../components/primitives.tsx';
import { Ambient } from './Ambient.tsx';
import { Diagnostics, useReceiveStats } from './Diagnostics.tsx';
import { FileHostPlayer, SharedBar } from './FilePlayer.tsx';
import { MoviePlayer } from './MoviePlayer.tsx';
import { OwnPlayer } from './OwnPlayer.tsx';
import { ParticipantTile, ScreenTile } from './Tile.tsx';

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function TileGrid(props: { session: RoomSession; people: ParticipantView[] }) {
  const [ref, size] = useSize();
  const gap = size.w < 600 ? 8 : 12;
  const fit = fitGrid(props.people.length, size.w, size.h, gap);
  // Tiles move and resize with transforms (FLIP), never by animating layout:
  // animating width while the stage itself is resizing makes rows re-wrap.
  const flip = useFlip([props.people.map((p) => p.identity).join(','), fit.w, fit.h, fit.cols]);
  return (
    <div class="grid" ref={ref}>
      <div class="grid-inner" ref={flip} style={{ gap: `${gap}px`, width: `${fit.cols * fit.w + (fit.cols - 1) * gap}px` }}>
      {fit.w > 0 &&
        props.people.map((p) => (
          <div key={p.identity} class="grid-cell" data-flip={`cell-${p.identity}`} style={{ width: `${fit.w}px`, height: `${fit.h}px` }}>
            <ParticipantTile session={props.session} view={p} compact={fit.w < 200} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ShareOverlay(props: {
  session: RoomSession;
  view: ParticipantView;
  fullscreen: boolean;
  onFullscreen: () => void;
  onChangeSource: () => void;
}) {
  const { session, view: v } = props;
  const [stats, setStats] = useState(false);
  const track = v.participant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
  const receive = useReceiveStats(v.isLocal ? undefined : track, stats && !v.isLocal);
  const hasAudio = !!v.participant.getTrackPublication(Track.Source.ScreenShareAudio);
  const fileShow = session.fileShow.value;
  const file = fileShow && fileShow.host === v.identity ? fileShow : undefined;
  const [asked, setAsked] = useState(false);

  return (
    <>
      <div class="content-chip live" data-testid="share-live-chip">
        <span class="live-dot" />
        {file
          ? `${v.name || 'Someone'} is playing ${file.name} · anyone can pause`
          : v.isLocal
            ? 'You are sharing your screen'
            : `${v.name || 'Someone'} is sharing`}
        {!file && hasAudio && ' · with audio'}
      </div>
      <div class="content-tools" onPointerDown={(e) => e.stopPropagation()}>
        <IconButton label="Diagnostics" tipPos="below" pressed={stats} onClick={() => setStats(!stats)} data-testid="diag-toggle">
          <Activity />
        </IconButton>
        <IconButton label={props.fullscreen ? 'Leave fullscreen' : 'Fullscreen'} tipPos="left" onClick={props.onFullscreen} data-testid="fullscreen">
          {props.fullscreen ? <Minimize /> : <Maximize />}
        </IconButton>
      </div>
      {file && <SharedBar session={session} show={file} />}
      {!file && !v.isLocal && hasAudio && (
        <div class="content-actions" onPointerDown={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            disabled={asked}
            data-tip={`Only ${v.name || 'the sharer'} can press pause in a shared tab`}
            onClick={() => {
              if (session.nudge('pause')) {
                setAsked(true);
                setTimeout(() => setAsked(false), 4000);
              }
            }}
            data-testid="ask-pause"
          >
            <Hand />
            {asked ? `Asked ${v.name || 'them'}` : 'Ask to pause'}
          </Button>
        </div>
      )}
      {v.isLocal && (
        <div class="content-actions" onPointerDown={(e) => e.stopPropagation()}>
          <Button size="sm" onClick={props.onChangeSource}>
            <RefreshCw />
            Change source
          </Button>
          <Button size="sm" variant="danger" onClick={() => void session.share.stop()} data-testid="share-stop">
            <Square />
            Stop sharing
          </Button>
        </div>
      )}
      {stats && (
        <Diagnostics session={session} mode={v.isLocal ? 'send' : 'receive'} receive={receive} onClose={() => setStats(false)} />
      )}
    </>
  );
}

export function Stage(props: {
  session: RoomSession;
  layout: LayoutMode;
  fullscreen: boolean;
  onFullscreen: () => void;
  onChangeSource: () => void;
  onHasContent: (has: boolean) => void;
}) {
  const { session, layout } = props;
  const people = session.participants.value;
  const movie = session.movie.value;
  session.trackVersion.value; // re-evaluate when tracks change
  const hostingFile = !!session.localFile.value;
  const sharers = people.filter((p) => {
    // While we play a file ourselves, our own player is the picture.
    if (hostingFile && p.isLocal) return false;
    const pub = p.participant.getTrackPublication(Track.Source.ScreenShare);
    return !!pub?.videoTrack;
  });
  const [focus, setFocus] = useState<string | null>(null);

  const keys = [...(hostingFile ? ['file'] : []), ...sharers.map((s) => `screen:${s.identity}`), ...(movie ? ['movie'] : [])];
  const current = focus && keys.includes(focus) ? focus : keys[0];
  const hasContent = keys.length > 0;
  useEffect(() => props.onHasContent(hasContent), [hasContent]);

  const flip = useFlip([people.map((p) => p.identity).join(','), current, layout, hasContent]);
  const contentRef = useRef<HTMLDivElement>(null);
  const primary = current?.startsWith('screen:') ? sharers.find((s) => `screen:${s.identity}` === current) : undefined;
  const others = keys.filter((k) => k !== current);

  return (
    <div class={`stage ${hasContent ? `has-content layout-${layout}` : ''}`} ref={flip} data-testid="stage" data-layout={hasContent ? layout : 'grid'}>
      {hasContent ? (
        <>
          <div class="content" ref={contentRef}>
            <Ambient key={current} find={() => contentRef.current?.querySelector('.content-tile video') as HTMLVideoElement | null} />
            {current === 'file' ? (
              <FileHostPlayer session={session} />
            ) : current === 'movie' ? (
              movie?.kind === 'own' ? <OwnPlayer session={session} /> : <MoviePlayer session={session} />
            ) : (
              primary && (
                <ScreenTile key={primary.identity} session={session} view={primary}>
                  <ShareOverlay
                    session={session}
                    view={primary}
                    fullscreen={props.fullscreen}
                    onFullscreen={props.onFullscreen}
                    onChangeSource={props.onChangeSource}
                  />
                </ScreenTile>
              )
            )}
          </div>
          {layout !== 'cinema' && (
            <div class="strip">
              {others.map((k) => (
                <button type="button" key={k} class="strip-switch" onClick={() => setFocus(k)}>
                  <MonitorUp />
                  <span>{k === 'file' ? 'Your file' : k === 'movie' ? 'Watch together' : `${sharers.find((s) => `screen:${s.identity}` === k)?.name || 'Someone'}’s screen`}</span>
                </button>
              ))}
              {layout === 'social' ? (
                <TileGrid session={session} people={people} />
              ) : (
                people.map((p) => (
                  <div key={p.identity} class="strip-cell">
                    <ParticipantTile session={session} view={p} compact />
                  </div>
                ))
              )}
            </div>
          )}
        </>
      ) : (
        <TileGrid session={session} people={people} />
      )}

      <div class="reactions" aria-hidden="true">
        {session.reactions.value.map((r) => (
          <span key={r.id} class="reaction-float" style={{ left: `${r.x * 100}%` }}>
            <span class="reaction-emoji">{r.emoji}</span>
            <span class="reaction-who">{session.nameOf(r.from)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
