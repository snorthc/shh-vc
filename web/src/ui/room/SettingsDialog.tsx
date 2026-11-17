import { useEffect, useState } from 'preact/hooks';
import { Info } from 'lucide-preact';
import { settings, updateSettings } from '../../app/settings.ts';
import type { RoomSession } from '../../call/session.ts';
import { play, unlockAudio } from '../../sfx/sounds.ts';
import { shareAudioSupport } from '../../share/support.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Avatar, Button, Row, Segmented, Slider, Switch } from '../components/primitives.tsx';
import { SuppressionPicker } from '../components/SuppressionPicker.tsx';
import { ShareQuality } from './ShareQuality.tsx';

type Tab = 'profile' | 'devices' | 'share' | 'sounds';

function useDevices(open: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) return;
    let alive = true;
    const load = () =>
      navigator.mediaDevices.enumerateDevices().then((d) => {
        if (alive) setDevices(d);
      });
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', load);
    };
  }, [open]);
  return devices;
}

function DeviceSelect(props: {
  kind: MediaDeviceKind;
  label: string;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  const list = props.devices.filter((d) => d.kind === props.kind && d.deviceId);
  const named = list.some((d) => d.label);
  return (
    <div class="field">
      <label class="label" for={`dev-${props.kind}`}>
        {props.label}
      </label>
      <select
        id={`dev-${props.kind}`}
        class="select"
        value={props.value}
        disabled={list.length === 0}
        onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}
      >
        <option value="">System default</option>
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${props.label} ${i + 1}`}
          </option>
        ))}
      </select>
      {!named && (
        <span class="hint">Device names appear once this site has been allowed to use them.</span>
      )}
    </div>
  );
}

export function SettingsDialog(props: {
  open: boolean;
  onClose: () => void;
  session?: RoomSession;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(props.initialTab ?? 'profile');
  useEffect(() => {
    if (props.open && props.initialTab) setTab(props.initialTab);
  }, [props.open, props.initialTab]);
  const s = settings.value;
  const devices = useDevices(props.open && tab === 'devices');
  const session = props.session;
  const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  const audio = shareAudioSupport();

  const setDevice = (kind: MediaDeviceKind, id: string) => {
    if (session) void session.setDevice(kind, id);
    else updateSettings(kind === 'audioinput' ? { micId: id } : kind === 'videoinput' ? { camId: id } : { speakerId: id });
  };
  const setProcessing = (patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch);
    void session?.applyMicProcessing();
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Settings" width={560} testId="settings">
      <Segmented
        class="settings-tabs"
        label="Settings section"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'profile', label: 'Profile' },
          { value: 'devices', label: 'Audio & video' },
          { value: 'share', label: 'Sharing' },
          { value: 'sounds', label: 'Sounds' },
        ]}
      />

      <div class="settings-pane" key={tab}>
        {tab === 'profile' && (
          <>
            <div class="profile-row">
              <Avatar name={s.name || 'Guest'} hue={s.hue} size={56} />
              <div class="field grow">
                <label class="label" for="set-name">
                  Display name
                </label>
                <input
                  id="set-name"
                  class="input"
                  type="text"
                  maxLength={48}
                  autocomplete="off"
                  value={s.name}
                  placeholder="Guest"
                  onInput={(e) => updateSettings({ name: (e.target as HTMLInputElement).value })}
                />
              </div>
            </div>
            <div class="field">
              <span class="label">Avatar colour</span>
              <Slider
                label="Avatar colour"
                min={0}
                max={359}
                step={1}
                value={s.hue}
                onInput={(hue) => updateSettings({ hue })}
                onCommit={() => session?.presenceChanged()}
              />
            </div>
            <div class="note">
              <Info />
              <span>
                Your name travels to other participants inside the encrypted channel; the server never
                sees it. {session ? 'A new name applies the next time you join a room.' : 'It is stored only on this device.'}
              </span>
            </div>
          </>
        )}

        {tab === 'devices' && (
          <>
            <DeviceSelect kind="audioinput" label="Microphone" devices={devices} value={s.micId} onChange={(id) => setDevice('audioinput', id)} />
            {canPickSpeaker ? (
              <DeviceSelect kind="audiooutput" label="Speaker" devices={devices} value={s.speakerId} onChange={(id) => setDevice('audiooutput', id)} />
            ) : (
              <div class="note">
                <Info />
                <span>This browser always plays through the system’s default output, so there is no speaker to choose here.</span>
              </div>
            )}
            <DeviceSelect kind="videoinput" label="Camera" devices={devices} value={s.camId} onChange={(id) => setDevice('videoinput', id)} />

            <h3 class="section-title">Noise suppression</h3>
            <SuppressionPicker
              value={session ? session.micSuppression.value : s.suppression}
              note={session?.suppressionNote.value}
              onChange={(v) => (session ? void session.setSuppression(v) : updateSettings({ suppression: v }))}
            />

            <h3 class="section-title">Microphone processing</h3>
            <Row title="Echo cancellation" sub="Keep on unless you are wearing headphones.">
              <Switch label="Echo cancellation" checked={s.echoCancellation} onChange={(v) => setProcessing({ echoCancellation: v })} />
            </Row>
            <Row title="Automatic gain" sub="Evens out how loud you sound.">
              <Switch label="Automatic gain" checked={s.autoGain} onChange={(v) => setProcessing({ autoGain: v })} />
            </Row>

            <h3 class="section-title">Joining</h3>
            <Row title="Join with microphone muted">
              <Switch label="Join with microphone muted" checked={s.joinMuted} onChange={(v) => updateSettings({ joinMuted: v })} />
            </Row>
            <Row title="Join with camera off">
              <Switch label="Join with camera off" checked={s.joinCameraOff} onChange={(v) => updateSettings({ joinCameraOff: v })} />
            </Row>
            <Row title="Mirror my own video" sub="Only changes how you see yourself.">
              <Switch label="Mirror my own video" checked={s.mirrorSelf} onChange={(v) => updateSettings({ mirrorSelf: v })} />
            </Row>
          </>
        )}

        {tab === 'share' && (
          <>
            <h3 class="section-title">Default quality</h3>
            <ShareQuality onChange={() => void session?.share.applyQuality()} />
            <h3 class="section-title">Audio</h3>
            <Row title="Share audio from the source" sub={audio.explanation}>
              <Switch
                label="Share audio from the source"
                checked={s.shareAudio && audio.available}
                disabled={!audio.available}
                onChange={(v) => updateSettings({ shareAudio: v })}
              />
            </Row>
          </>
        )}

        {tab === 'sounds' && (
          <>
            <Row title="Interface sounds" sub="Short tones for joining, messages, mute, deafen and sharing.">
              <Switch label="Interface sounds" checked={s.sfxEnabled} onChange={(v) => updateSettings({ sfxEnabled: v })} />
            </Row>
            <div class="field" style={{ marginTop: '12px' }}>
              <span class="label">Volume</span>
              <Slider
                label="Interface sound volume"
                value={s.sfxVolume}
                disabled={!s.sfxEnabled}
                onInput={(sfxVolume) => updateSettings({ sfxVolume })}
                onCommit={() => play('receive')}
              />
            </div>
            <div style={{ marginTop: '16px' }}>
              <Button
                disabled={!s.sfxEnabled || s.sfxVolume === 0}
                onClick={() => {
                  unlockAudio();
                  play('notify');
                }}
              >
                Play a test sound
              </Button>
            </div>
            <p class="hint" style={{ marginTop: '16px' }}>
              These are interface sounds only and never affect the call’s audio. Browsers stay
              silent until you have clicked or typed on the page.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
