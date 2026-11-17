import { useRef, useState } from 'preact/hooks';
import { Check, Copy, EllipsisVertical, HeadphoneOff, Lock, LockOpen, MicOff, MonitorUp, ShieldEllipsis, SignalLow, UserMinus, VolumeX, Volume2 } from 'lucide-preact';
import { FROM_FILE } from '../../app/mode.ts';
import { inviteLink } from '../../app/state.ts';
import type { ParticipantView, RoomSession } from '../../call/session.ts';
import { MenuItem, Popover } from '../components/Popover.tsx';
import { Avatar, Button, IconButton, Slider, Switch } from '../components/primitives.tsx';

function PersonRow(props: { session: RoomSession; view: ParticipantView }) {
  const { session, view: v } = props;
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const audio = session.peerAudio.value[v.identity] ?? { volume: 1, muted: false };
  const host = session.isHost.value;
  const name = v.name || 'Joining…';

  return (
    <li class={`person ${v.speaking ? 'speaking' : ''}`} data-testid="person" data-identity={v.identity}>
      <Avatar name={name} hue={v.hue} size={34} />
      <div class="person-main">
        <div class="person-name">
          <span>{name}</span>
          {v.isLocal && <span class="tag">You</span>}
          {v.isHost && <span class="tag host">Host</span>}
        </div>
        <div class="person-sub">
          {!v.keyed ? (
            <>
              <ShieldEllipsis /> Securing connection
            </>
          ) : (
            <span class="mono" title="Verification code">
              {v.code}
            </span>
          )}
        </div>
      </div>
      <div class="person-states">
        {v.sharing && <span class="live" title="Sharing their screen"><MonitorUp /></span>}
        {v.quality === 'poor' && <span class="warn" title="Poor connection"><SignalLow /></span>}
        {audio.muted && !v.isLocal && <span title="Muted for you"><VolumeX /></span>}
        {v.deafened && <span class="off" title="Deafened: cannot hear the room"><HeadphoneOff /></span>}
        {!v.micOn && <span class="off" title="Microphone muted"><MicOff /></span>}
      </div>
      {!v.isLocal && (
        <IconButton label={`Options for ${name}`} btnRef={anchor} tipPos="left" onClick={() => { setOpen(!open); setConfirmRemove(false); }} pressed={open}>
          <EllipsisVertical />
        </IconButton>
      )}

      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" placement="below" label={`Options for ${name}`}>
        <div class="menu-label">Volume for you</div>
        <div class="menu-slider">
          <Volume2 />
          <Slider
            label={`Volume of ${name} for you`}
            min={0}
            max={1}
            value={audio.muted ? 0 : audio.volume}
            onInput={(volume) => session.setPeerAudio(v.identity, { volume, muted: volume === 0 })}
          />
        </div>
        <MenuItem
          icon={<VolumeX />}
          label={audio.muted ? 'Unmute for me' : 'Mute for me'}
          sub="Only changes what you hear."
          onSelect={() => session.setPeerAudio(v.identity, { muted: !audio.muted })}
        />
        {host && !v.isHost && (
          <>
            <div class="menu-sep" />
            <div class="menu-label">Host</div>
            <MenuItem
              icon={<MicOff />}
              label="Mute for everyone"
              sub="They can unmute themselves."
              disabled={!v.micOn}
              onSelect={() => { void session.hostAction('mute', v.identity); setOpen(false); }}
            />
            <MenuItem
              icon={<UserMinus />}
              danger
              label={confirmRemove ? 'Click again to remove' : 'Remove from room'}
              sub="They can rejoin with the link unless the room is locked."
              onSelect={() => {
                if (!confirmRemove) return setConfirmRemove(true);
                void session.hostAction('remove', v.identity);
                setOpen(false);
              }}
            />
          </>
        )}
      </Popover>
    </li>
  );
}

export function PeoplePanel(props: { session: RoomSession }) {
  const { session } = props;
  const people = session.participants.value;
  const [copied, setCopied] = useState(false);
  const locked = session.locked.value;
  const host = session.isHost.value;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(session.roomSecret));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the link is still in the address bar */
    }
  };

  return (
    <div class="people" data-testid="people">
      <div class="people-count">
        <span>In the room</span>
        <span class="mono">{people.length} of 6</span>
      </div>
      <ul class="people-list">
        {people.map((p) => (
          <PersonRow key={p.identity} session={session} view={p} />
        ))}
      </ul>

      <div class="people-foot">
        {host ? (
          <div class="row">
            <div class="grow">
              <div class="row-title">Lock room</div>
              <div class="row-sub">Nobody new can join, even with the link.</div>
            </div>
            <Switch label="Lock room" checked={locked} onChange={(v) => void session.hostAction(v ? 'lock' : 'unlock')} />
          </div>
        ) : (
          locked && (
            <p class="locked-note">
              <Lock /> The host has locked this room.
            </p>
          )
        )}
        <Button block onClick={copy} disabled={locked && !host}>
          {copied ? <Check /> : locked ? <LockOpen /> : <Copy />}
          {FROM_FILE ? (copied ? 'Room code copied' : 'Copy room code') : copied ? 'Invite link copied' : 'Copy invite link'}
        </Button>
      </div>
    </div>
  );
}
