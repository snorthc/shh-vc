import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { HeadphoneOff, MicOff, ShieldEllipsis, SignalLow, WifiOff } from 'lucide-preact';
import { Track } from 'livekit-client';
import { settings } from '../../app/settings.ts';
import type { ParticipantView, RoomSession } from '../../call/session.ts';
import { Avatar } from '../components/primitives.tsx';

/** Attach a LiveKit track to a <video>, re-attaching whenever tracks change. */
export function useVideoTrack(
  session: RoomSession,
  view: ParticipantView,
  source: Track.Source,
) {
  const ref = useRef<HTMLVideoElement>(null);
  const version = session.trackVersion.value;
  const pub = view.participant.getTrackPublication(source);
  const track = pub?.videoTrack;
  const live = !!track && !pub?.isMuted;

  useEffect(() => {
    const el = ref.current;
    if (!el || !track || !live) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, live, version]);

  return { ref, live };
}

export function ParticipantTile(props: {
  session: RoomSession;
  view: ParticipantView;
  compact?: boolean;
}) {
  const { view: v, session } = props;
  const { ref, live } = useVideoTrack(session, v, Track.Source.Camera);
  const tileRef = useRef<HTMLDivElement>(null);
  const lost = v.quality === 'lost';

  // The speaking halo follows the voice: written straight to a CSS variable,
  // so a loud room costs no re-renders.
  useEffect(() => {
    const el = tileRef.current;
    if (!el) return;
    let smooth = 0;
    const t = setInterval(() => {
      const level = v.participant.isMicrophoneEnabled ? (v.participant.audioLevel ?? 0) : 0;
      smooth = Math.max(level, smooth * 0.72);
      el.style.setProperty('--level', Math.min(1, smooth * 1.8).toFixed(3));
    }, 90);
    return () => clearInterval(t);
  }, [v.participant]);
  const name = v.name || (v.keyed ? 'Guest' : 'Joining…');

  return (
    <div
      ref={tileRef}
      class={`tile ${v.speaking ? 'speaking' : ''} ${props.compact ? 'compact' : ''} ${lost ? 'lost' : ''}`}
      style={{ '--hue': v.hue }}
      data-identity={v.identity}
      data-testid={v.isLocal ? 'tile-self' : 'tile-peer'}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        class={v.isLocal && settings.value.mirrorSelf ? 'mirror' : ''}
        style={{ opacity: live ? 1 : 0 }}
      />
      {!live && (
        <div class="tile-plate">
          <span class="halo">
            <Avatar name={name} hue={v.hue} size={props.compact ? 40 : 84} />
          </span>
        </div>
      )}

      {!v.keyed && !v.isLocal && (
        <div class="tile-status">
          <ShieldEllipsis />
          {!props.compact && <span>Securing connection</span>}
        </div>
      )}
      {lost && (
        <div class="tile-status">
          <WifiOff />
          {!props.compact && <span>Reconnecting</span>}
        </div>
      )}

      <div class="tile-label">
        {!v.micOn && (
          <span class="state off" title="Microphone muted">
            <MicOff />
          </span>
        )}
        {v.deafened && (
          <span class="state off" title="Deafened: cannot hear the room">
            <HeadphoneOff />
          </span>
        )}
        <span class="tile-name">
          {name}
          {v.isLocal && <span class="you"> (you)</span>}
        </span>
        {v.quality === 'poor' && (
          <span class="state warn" title="Poor connection">
            <SignalLow />
          </span>
        )}
      </div>
    </div>
  );
}

export function ScreenTile(props: {
  session: RoomSession;
  view: ParticipantView;
  children?: ComponentChildren;
  onVideo?: (el: HTMLVideoElement | null) => void;
}) {
  const { view: v, session } = props;
  const { ref } = useVideoTrack(session, v, Track.Source.ScreenShare);
  useEffect(() => {
    props.onVideo?.(ref.current);
    return () => props.onVideo?.(null);
  }, []);
  return (
    <div class="content-tile" data-flip={`screen-${v.identity}`} data-testid="screen-tile" data-identity={v.identity}>
      <video ref={ref} autoPlay playsInline muted />
      {props.children}
    </div>
  );
}
