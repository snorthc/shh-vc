/**
 * Screen sharing, in three deliberate steps:
 *
 *   choose  -> the browser's own picker hands us a capture stream
 *   preview -> the stream is shown ONLY on this device
 *   confirm -> the track is published to the room
 *
 * Until confirm() runs, nothing from the capture is sent anywhere: the track
 * is not attached to any peer connection. Cancelling stops the capture.
 * The browser's picker cannot be skipped or replaced — it is the security
 * boundary, and the only way a page is allowed to see a screen.
 */
import { signal } from '@preact/signals';
import {
  AudioPresets,
  type LocalTrackPublication,
  type LocalVideoTrack,
  Track,
  type TrackPublishOptions,
} from 'livekit-client';
import { settings } from '../app/settings.ts';
import { toast } from '../app/toasts.ts';
import { describeError } from '../app/util.ts';
import { mediaErrorText } from '../call/errors.ts';
import type { RoomSession } from '../call/session.ts';
import { screenShareSupported, shareAudioSupport } from './support.ts';
import { play } from '../sfx/sounds.ts';
import {
  type DisplaySurface,
  type ResolvedShare,
  resolveShare,
  widthFor,
} from './presets.ts';
import { parseVideoStats, type StatSample, withBitrate } from './stats.ts';

export type SharePhase = 'idle' | 'choosing' | 'preview' | 'starting' | 'live';

export interface CaptureInfo {
  label: string;
  surface: DisplaySurface;
  width?: number;
  height?: number;
  frameRate?: number;
  hasAudio: boolean;
  audioLabel?: string;
}

export class ShareController {
  readonly phase = signal<SharePhase>('idle');
  readonly info = signal<CaptureInfo | undefined>(undefined);
  readonly error = signal<string | undefined>(undefined);
  /** The capture, visible on this device only until confirmed. */
  readonly previewStream = signal<MediaStream | undefined>(undefined);
  /** True when the preview would replace a share that is already live. */
  readonly replacing = signal(false);
  readonly applied = signal<ResolvedShare | undefined>(undefined);
  readonly sendStats = signal<StatSample | undefined>(undefined);
  readonly audioLive = signal(false);

  private pending: MediaStream | undefined;
  private live: { stream: MediaStream; video?: LocalTrackPublication; audio?: LocalTrackPublication } | undefined;
  private infoTimer: ReturnType<typeof setInterval> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private lastSample: StatSample | undefined;

  constructor(private readonly session: RoomSession) {}

  get supported(): boolean {
    return screenShareSupported();
  }

  resolved(): ResolvedShare {
    const s = settings.value;
    return resolveShare(s.sharePreset, s.shareCustom);
  }

  /** Step 1: open the browser's picker. Resolves once a source is in preview. */
  async choose(): Promise<void> {
    if (!this.supported) {
      this.error.value = 'This browser cannot share a screen.';
      return;
    }
    if (this.phase.value === 'choosing' || this.phase.value === 'starting') return;
    // One person shares one thing: a screen replaces a file being played.
    if (this.session.localFile.value) await this.session.stopFileShow();
    this.discardPending();
    this.error.value = undefined;
    this.replacing.value = this.phase.value === 'live';
    const before = this.phase.value;
    this.phase.value = this.replacing.value ? 'live' : 'choosing';

    const r = this.resolved();
    const wantAudio = settings.value.shareAudio && shareAudioSupport().available;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: widthFor(r.quality.height) },
          height: { ideal: r.quality.height },
          frameRate: { ideal: r.quality.fps, max: r.quality.fps },
        },
        audio: wantAudio
          ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : false,
        // Chromium-only hints; other browsers ignore unknown members.
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: wantAudio ? 'include' : 'exclude',
      } as DisplayMediaStreamOptions);

      const video = stream.getVideoTracks()[0];
      if (!video) {
        for (const t of stream.getTracks()) t.stop();
        throw new Error('The browser returned no video for that source.');
      }
      if (r.contentHint) video.contentHint = r.contentHint;
      // The browser's own "Stop sharing" bar ends the track; follow it.
      video.addEventListener('ended', () => this.onCaptureEnded(stream));

      this.pending = stream;
      this.previewStream.value = stream;
      this.readInfo(stream);
      this.infoTimer = setInterval(() => this.readInfo(stream), 700);
      if (!this.replacing.value) this.phase.value = 'preview';
    } catch (err) {
      this.phase.value = before === 'live' ? 'live' : 'idle';
      this.replacing.value = false;
      this.error.value = mediaErrorText(err, 'screen');
    }
  }

  private readInfo(stream: MediaStream): void {
    const video = stream.getVideoTracks()[0];
    if (!video) return;
    const st = video.getSettings() as MediaTrackSettings & { displaySurface?: string };
    const audio = stream.getAudioTracks()[0];
    const surface: DisplaySurface =
      st.displaySurface === 'monitor' || st.displaySurface === 'window' || st.displaySurface === 'browser'
        ? st.displaySurface
        : 'unknown';
    this.info.value = {
      label: video.label || '',
      surface,
      width: st.width,
      height: st.height,
      frameRate: st.frameRate,
      hasAudio: !!audio,
      audioLabel: audio?.label,
    };
  }

  /** Step 3: publish what is in the preview. Nothing is sent before this. */
  async confirm(): Promise<void> {
    const stream = this.pending;
    if (!stream) return;
    const video = stream.getVideoTracks()[0];
    if (!video || video.readyState !== 'live') {
      this.cancel();
      this.error.value = 'That source stopped before it was shared. Choose it again.';
      return;
    }
    const wasReplacing = this.replacing.value && this.live;
    this.phase.value = wasReplacing ? 'live' : 'starting';
    const r = this.resolved();
    const local = this.session.room.localParticipant;

    try {
      if (wasReplacing && this.live?.video?.track) {
        const old = this.live.stream;
        await (this.live.video.track as LocalVideoTrack).replaceTrack(video, true);
        if (this.live.audio?.track) {
          await local.unpublishTrack(this.live.audio.track, true);
          this.live.audio = undefined;
        }
        for (const t of old.getTracks()) if (t !== video) t.stop();
        this.live.stream = stream;
      } else {
        this.live = { stream, video: await this.publishVideo(video, r) };
      }
      const audio = stream.getAudioTracks()[0];
      if (audio && this.live) {
        this.live.audio = await local.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio,
          name: 'screen-audio',
          audioPreset: AudioPresets.musicHighQuality,
          dtx: false,
          red: false,
        });
      }
      this.audioLive.value = !!this.live?.audio;
      this.pending = undefined;
      this.previewStream.value = undefined;
      this.replacing.value = false;
      this.applied.value = r;
      this.phase.value = 'live';
      await this.applyEncoding(r);
      this.startStats();
      play('shareStart');
      this.session.refresh();
    } catch (err) {
      this.error.value = `Could not start sharing: ${describeError(err)}`;
      this.cancel();
      if (!this.live) this.phase.value = 'idle';
      play('error');
    }
  }

  private async publishVideo(track: MediaStreamTrack, r: ResolvedShare): Promise<LocalTrackPublication> {
    const local = this.session.room.localParticipant;
    const options = (codec: 'vp9' | 'vp8'): TrackPublishOptions => ({
      source: Track.Source.ScreenShare,
      name: 'screen',
      videoCodec: codec,
      // One sharp layer: a share is the thing people are reading.
      simulcast: false,
      backupCodec: false,
      ...(codec === 'vp9' ? { scalabilityMode: 'L1T3' as const } : {}),
      screenShareEncoding: { maxBitrate: r.maxBitrate, maxFramerate: r.quality.fps },
      degradationPreference: r.degradation,
    });
    try {
      return await local.publishTrack(track, options(r.codec));
    } catch (err) {
      if (r.codec === 'vp8') throw err;
      return local.publishTrack(track, options('vp8'));
    }
  }

  /** Step 2 alternative: throw the capture away. Stops the browser's capture. */
  cancel(): void {
    this.discardPending();
    this.replacing.value = false;
    if (this.phase.value !== 'live') this.phase.value = 'idle';
  }

  private discardPending(): void {
    if (this.infoTimer) clearInterval(this.infoTimer);
    this.infoTimer = undefined;
    if (this.pending) for (const t of this.pending.getTracks()) t.stop();
    this.pending = undefined;
    this.previewStream.value = undefined;
    if (this.phase.value !== 'live') this.info.value = undefined;
  }

  async stop(silent = false): Promise<void> {
    this.discardPending();
    const live = this.live;
    this.live = undefined;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    this.lastSample = undefined;
    this.sendStats.value = undefined;
    this.audioLive.value = false;
    this.applied.value = undefined;
    this.info.value = undefined;
    this.replacing.value = false;
    this.phase.value = 'idle';
    if (live) {
      const local = this.session.room.localParticipant;
      try {
        if (live.video?.track) await local.unpublishTrack(live.video.track, true);
        if (live.audio?.track) await local.unpublishTrack(live.audio.track, true);
      } catch {
        // Already gone, e.g. the room disconnected first.
      }
      for (const t of live.stream.getTracks()) t.stop();
      if (!silent) play('shareStop');
    }
    this.session.refresh();
  }

  private onCaptureEnded(stream: MediaStream): void {
    if (this.pending === stream) {
      this.cancel();
      return;
    }
    if (this.live?.stream === stream) {
      toast('Screen sharing stopped', 'info');
      void this.stop();
    }
  }

  /**
   * Apply the current quality settings to a live share (or a preview): capture
   * constraints on the track, bitrate and frame-rate ceilings on the sender.
   */
  async applyQuality(): Promise<void> {
    const r = this.resolved();
    const stream = this.live?.stream ?? this.pending;
    const video = stream?.getVideoTracks()[0];
    if (!video) return;
    try {
      await video.applyConstraints({
        width: { ideal: widthFor(r.quality.height) },
        height: { ideal: r.quality.height },
        frameRate: { ideal: r.quality.fps, max: r.quality.fps },
      });
    } catch {
      // The source cannot satisfy it; the shortfall note in the UI says so.
    }
    video.contentHint = r.contentHint;
    if (stream) this.readInfo(stream);
    if (this.live) {
      await this.applyEncoding(r);
      // A codec is fixed when the track is published; keep reporting the live one.
      this.applied.value = { ...r, codec: this.applied.value?.codec ?? r.codec };
    }
  }

  private async applyEncoding(r: ResolvedShare): Promise<void> {
    const track = this.live?.video?.track as LocalVideoTrack | undefined;
    const sender = track?.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      for (const enc of params.encodings ?? []) {
        enc.maxBitrate = r.maxBitrate;
        enc.maxFramerate = r.quality.fps;
      }
      params.degradationPreference = r.degradation;
      await sender.setParameters(params);
    } catch (err) {
      toast('The browser rejected that quality setting', 'warn', describeError(err));
    }
  }

  /** The sender's actual encoding parameters, for display and for tests. */
  senderParameters(): { maxBitrate?: number; maxFramerate?: number; degradation?: string } | undefined {
    const track = this.live?.video?.track as LocalVideoTrack | undefined;
    const params = track?.sender?.getParameters();
    const enc = params?.encodings?.[0];
    if (!enc) return undefined;
    return { maxBitrate: enc.maxBitrate, maxFramerate: enc.maxFramerate, degradation: params?.degradationPreference };
  }

  private startStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    const tick = async () => {
      const track = this.live?.video?.track;
      if (!track) return;
      const report = await track.getRTCStatsReport().catch(() => undefined);
      if (!report) return;
      const entries: Record<string, unknown>[] = [];
      report.forEach((v) => entries.push(v as Record<string, unknown>));
      const sample = withBitrate(this.lastSample, parseVideoStats(entries, 'send', Date.now()));
      this.lastSample = sample;
      this.sendStats.value = sample;
    };
    void tick();
    this.statsTimer = setInterval(() => void tick(), 1000);
  }

  dispose(): void {
    void this.stop(true);
  }
}
