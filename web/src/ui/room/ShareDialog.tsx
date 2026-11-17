import { useEffect, useRef } from 'preact/hooks';
import { AppWindow, EyeOff, Monitor, MousePointerClick, PanelTop, RefreshCw, TriangleAlert, Volume2, VolumeX } from 'lucide-preact';
import { settings, updateSettings } from '../../app/settings.ts';
import type { RoomSession } from '../../call/session.ts';
import { shareAudioSupport } from '../../share/support.ts';
import { captureShortfall, surfaceLabel } from '../../share/presets.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Button, Switch } from '../components/primitives.tsx';
import { ShareQuality } from './ShareQuality.tsx';

const SURFACE_ICON = { monitor: Monitor, window: AppWindow, browser: PanelTop, unknown: Monitor };

/**
 * The step between choosing a source and sharing it. The preview is local:
 * the capture is not attached to the call until "Start sharing" is pressed.
 */
export function ShareDialog(props: { session: RoomSession; open: boolean; onClose: () => void }) {
  const share = props.session.share;
  const phase = share.phase.value;
  const stream = share.previewStream.value;
  const info = share.info.value;
  const error = share.error.value;
  const replacing = share.replacing.value;
  const videoRef = useRef<HTMLVideoElement>(null);
  const audio = shareAudioSupport();
  const s = settings.value;
  const resolved = share.resolved();
  const starting = phase === 'starting';

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream ?? null;
  }, [stream]);

  const close = () => {
    share.cancel();
    share.error.value = undefined;
    props.onClose();
  };

  const start = async () => {
    await share.confirm();
    if (share.phase.value === 'live' && !share.error.value) props.onClose();
  };

  const SurfaceIcon = SURFACE_ICON[info?.surface ?? 'unknown'];
  const shortfall = info ? captureShortfall(resolved.quality, { height: info.height, frameRate: info.frameRate }) : undefined;
  const waiting = !stream && !error;

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={replacing ? 'Switch what you are sharing' : 'Share your screen'}
      subtitle={
        stream
          ? replacing
            ? 'People keep seeing your current share until you confirm.'
            : 'Check the preview. Nothing is shared until you press Start sharing.'
          : undefined
      }
      width={920}
      class="share-dialog"
      testId="share-dialog"
      footer={
        stream ? (
          <>
            <Button onClick={close} disabled={starting} data-testid="share-cancel">
              Cancel
            </Button>
            <Button onClick={() => void share.choose()} disabled={starting}>
              <RefreshCw />
              Choose something else
            </Button>
            <Button variant="primary" onClick={() => void start()} loading={starting} data-testid="share-confirm" data-autofocus>
              {replacing ? 'Switch to this' : 'Start sharing'}
            </Button>
          </>
        ) : error ? (
          <>
            <Button onClick={close}>Close</Button>
            <Button variant="primary" onClick={() => void share.choose()} data-testid="share-retry">
              Try again
            </Button>
          </>
        ) : (
          <Button onClick={close}>Cancel</Button>
        )
      }
    >
      <div class="share-layout">
        <div class="share-preview">
          <div class={`share-frame ${stream ? 'has-stream' : ''}`}>
            <video ref={videoRef} autoPlay playsInline muted data-testid="share-preview-video" />
            {waiting && (
              <div class="share-wait">
                <MousePointerClick />
                <strong>Choose what to share</strong>
                <span>Pick a screen, window or tab in your browser’s picker. You will see it here first.</span>
              </div>
            )}
            {error && !stream && (
              <div class="share-wait error" role="alert" data-testid="share-error">
                <TriangleAlert />
                <strong>Nothing is being shared</strong>
                <span>{error}</span>
              </div>
            )}
            {stream && (
              <div class="content-chip private" data-testid="share-private-chip">
                <EyeOff />
                {replacing ? 'Preview — only you can see this' : 'Not shared yet — only you can see this'}
              </div>
            )}
          </div>

          {stream && info && (
            <div class="share-source" data-testid="share-source">
              <SurfaceIcon />
              <div class="grow">
                <div class="row-title">{surfaceLabel(info.surface)}</div>
                <div class="row-sub">{info.label && !/^(screen|window|web-contents-media-stream):/i.test(info.label) ? info.label : 'Selected in your browser’s picker'}</div>
              </div>
              <span class="mono share-dims">
                {info.width && info.height ? `${info.width} × ${info.height}` : '—'}
                {info.frameRate ? ` · ${Math.round(info.frameRate)} fps` : ''}
              </span>
            </div>
          )}

          {stream && (
            <div class="share-notes">
              <div class="note">
                {info?.hasAudio ? <Volume2 /> : <VolumeX />}
                <span data-testid="share-audio-note">
                  {info?.hasAudio
                    ? 'Audio from this source will be shared too.'
                    : s.shareAudio && audio.available
                      ? 'The browser did not provide audio for this source, so the share will be silent. A browser tab is the most reliable source of audio.'
                      : 'Video only. Your microphone carries on separately.'}
                </span>
              </div>
              {shortfall && (
                <div class="note warn">
                  <TriangleAlert />
                  <span>{shortfall}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div class="share-side">
          <h3 class="section-title">Optimise for</h3>
          <ShareQuality compact onChange={() => void share.applyQuality()} />

          <h3 class="section-title">Audio</h3>
          <div class="row">
            <div class="grow">
              <div class="row-title">Share audio from the source</div>
              <div class="row-sub">
                {audio.available
                  ? stream
                    ? 'Changing this takes effect the next time you choose a source.'
                    : 'Tick “share audio” in the picker as well.'
                  : audio.explanation}
              </div>
            </div>
            <Switch
              label="Share audio from the source"
              checked={s.shareAudio && audio.available}
              disabled={!audio.available}
              onChange={(v) => updateSettings({ shareAudio: v })}
            />
          </div>
          {audio.available && <p class="hint">{audio.explanation}</p>}
        </div>
      </div>
    </Dialog>
  );
}
