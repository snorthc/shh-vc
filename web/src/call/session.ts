/**
 * One room, from the client's side: connection, key agreement, media, and the
 * encrypted application channel that carries chat, presence, reactions and
 * watch-together state.
 *
 * What the server learns: the room id (a hash), a random per-session identity,
 * every participant's IP address, and packet sizes and timing. What it never
 * learns: the room secret, any media key, any frame, any chat message, or a
 * display name.
 */
import { batch, signal } from '@preact/signals';
import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type TrackPublishOptions,
} from 'livekit-client';
import { DIRECT, RELAY_URLS } from '../app/mode.ts';
import { MicPipeline, type Suppression } from '../audio/mic.ts';
import { settings, updateSettings } from '../app/settings.ts';
import { toast } from '../app/toasts.ts';
import { describeError, hueFor } from '../app/util.ts';
import {
  applyChat,
  type ChatMessage,
  type ChatWire,
  MAX_MESSAGE_LENGTH,
  newMessageId,
  sanitizeText,
  setStatus,
} from '../chat/store.ts';
import { sha256 } from '@noble/hashes/sha2';
import { concat, randomBytes, toB64Url, utf8 } from '../crypto/bytes.ts';
import { GroupKeys, type RotationReason } from '../crypto/group.ts';
import { newIdentity } from '../crypto/identity.ts';
import type { RoomSecret } from '../crypto/secret.ts';
import {
  type AnnounceMessage,
  decodeMessage,
  encodeMessage,
  MAX_NAME_LENGTH,
  type VeilMessage,
} from '../crypto/wire.ts';
import {
  type Change,
  classifyChange,
  type ControlLevel,
  effectiveLevel,
  hostSeed,
  isLevel,
  mayChange,
  POLICY_INTERVAL_MS,
  signAsHost,
  verifyHost,
} from '../movie/control.ts';
import { PlayerLink } from '../movie/link.ts';
import { expectedPosition, type HeldState, type MovieState, shouldAdopt } from '../movie/sync.ts';
import { MeshRoom } from '../mesh/room.ts';
import { play } from '../sfx/sounds.ts';
import { ShareController } from '../share/controller.ts';
import { JoinError, mediaErrorText } from './errors.ts';
import { VeilKeyProvider } from './keyprovider.ts';
import { SignalChannel } from './signal.ts';

export type RoomStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export type EndReason = 'left' | 'removed' | 'room-closed' | 'connection-lost' | 'failed';

export interface ParticipantView {
  identity: string;
  name: string;
  hue: number;
  isLocal: boolean;
  isHost: boolean;
  /** Verification code; undefined until their key is verified. */
  code?: string;
  /** We hold their media key, so their audio, video and chat decrypt. */
  keyed: boolean;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  speaking: boolean;
  deafened: boolean;
  quality: Quality;
  participant: Participant;
}

export interface StageReaction {
  id: number;
  from: string;
  emoji: string;
  /** Horizontal position, 0–1, chosen by the receiver so each one drifts differently. */
  x: number;
}

/**
 * A video file one person is playing for the room. The file never leaves
 * their device as a file: their browser plays it and streams the picture and
 * sound, encrypted, like a screen share. Because Shh VC is the player,
 * anyone in the room can pause, play and skip.
 */
export interface FileShow {
  host: string;
  name: string;
  playing: boolean;
  position: number;
  duration: number;
  /** Local clock when this state arrived, for smooth time display. */
  at: number;
}

export type FileCommand = { action: 'play' | 'pause' } | { action: 'seek'; position: number };

export interface PeerAudio {
  volume: number;
  muted: boolean;
}

type AppWire =
  | ChatWire
  | { t: 'typing' }
  | { t: 'state'; deafened: boolean; hue: number; locked?: boolean; mrev: number }
  | { t: 'stage-react'; emoji: string }
  | { t: 'movie'; state: MovieState; sig?: string }
  | { t: 'policy'; level: ControlLevel; rev: number; sig: string }
  | { t: 'movie-req' }
  | { t: 'file-state'; name: string; playing: boolean; position: number; duration: number }
  | { t: 'file-end' }
  | ({ t: 'file-cmd'; sig?: string } & FileCommand)
  | { t: 'nudge'; kind: 'pause' | 'play' };

export interface SessionOptions {
  roomSecret: RoomSecret;
  displayName: string;
  /** Present only for whoever created the room. Authorises moderation, nothing else. */
  hostKey?: string;
  /** The host's public signing key from the invite link: who may set the playback rule. */
  hostPub?: string;
  apiBase?: string;
}

const APP_TOPIC = 'shhvc';
const RECONCILE_INTERVAL_MS = 1500;
const PRESENCE_INTERVAL_MS = 10_000;
const TYPING_TTL_MS = 4000;

function cameraPublishOptions(): TrackPublishOptions {
  return {
    videoCodec: 'vp8',
    // Safe with E2EE: every layer of one sender uses the same key.
    simulcast: true,
    videoEncoding: { maxBitrate: 900_000, maxFramerate: 30 },
    red: true,
    dtx: true,
  };
}

function qualityOf(p: Participant): Quality {
  switch (p.connectionQuality) {
    case ConnectionQuality.Excellent:
      return 'excellent';
    case ConnectionQuality.Good:
      return 'good';
    case ConnectionQuality.Poor:
      return 'poor';
    case ConnectionQuality.Lost:
      return 'lost';
    default:
      return 'unknown';
  }
}

function isHostParticipant(p: Participant): boolean {
  try {
    return (JSON.parse(p.metadata ?? '{}') as { host?: boolean }).host === true;
  } catch {
    return false;
  }
}

export class RoomSession {
  readonly room: Room;
  readonly identity = toB64Url(randomBytes(16));
  readonly roomSecret: RoomSecret;
  readonly share: ShareController;
  readonly displayName: string;

  // ---- reactive state ------------------------------------------------
  readonly status = signal<RoomStatus>('connecting');
  readonly endReason = signal<EndReason | undefined>(undefined);
  readonly endDetail = signal<string | undefined>(undefined);
  readonly participants = signal<ParticipantView[]>([]);
  /** Bumped whenever tracks change, so tiles re-attach their media. */
  readonly trackVersion = signal(0);
  readonly safety = signal({ number: '', selfCode: '' });
  readonly micOn = signal(false);
  readonly camOn = signal(false);
  readonly deafened = signal(false);
  readonly isHost = signal(false);
  readonly locked = signal(false);
  readonly messages = signal<ChatMessage[]>([]);
  readonly typing = signal<string[]>([]);
  readonly unread = signal(0);
  readonly chatVisible = signal(false);
  readonly reactions = signal<StageReaction[]>([]);
  readonly movie = signal<HeldState | undefined>(undefined);
  readonly peerAudio = signal<Record<string, PeerAudio>>({});
  readonly audioBlocked = signal(false);
  /** Serverless mode: false when no discovery relay can be reached. */
  readonly discoveryOnline = signal(true);
  /** The noise suppression actually running on the microphone. */
  readonly micSuppression = signal<Suppression>(settings.value.suppression);
  /** Set when an AI filter could not start and something else is in use. */
  readonly suppressionNote = signal<string | undefined>(undefined);
  /** A file being played for the room, by us or by someone else. */
  readonly fileShow = signal<FileShow | undefined>(undefined);
  /** Set on the device that owns the file. */
  readonly localFile = signal<File | undefined>(undefined);
  /** The host's player registers here to receive everyone's play, pause and skip. */
  onFileCommand: ((cmd: FileCommand, from: string) => void) | undefined;
  readonly startedAt = signal<number | undefined>(undefined);
  /** Public key of whoever may set the playback rule, if this room has a host. */
  readonly hostPub: string | undefined;
  /** True on the host's own device. */
  readonly controlHost: boolean;
  /** The rule the host chose. */
  readonly controlPolicy = signal<ControlLevel>('everyone');
  /** The rule in force right now (it lapses while the host is away). */
  readonly controlLevel = signal<ControlLevel>('everyone');
  /** A Netflix (or other site's) tab linked through the bookmarklet. */
  readonly link: PlayerLink;

  private readonly group: GroupKeys;
  private readonly keyProvider = DIRECT ? undefined : new VeilKeyProvider();
  private readonly signalCh: Pick<SignalChannel, 'connect' | 'send' | 'close'>;
  private readonly hostKey: string | undefined;
  private readonly apiBase: string;
  private worker: Worker | undefined;
  private closed = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly keyedPeers = new Set<string>();
  private readonly sentKeyIndex = new Map<string, number>();
  private readonly peerState = new Map<string, { deafened: boolean; hue: number }>();
  private readonly typingUntil = new Map<string, number>();
  private readonly audioHost: HTMLDivElement;
  private lastTypingSent = 0;
  private movieRev = 0;
  private reactionSeq = 1;
  /** What the user last asked the microphone to be, to tell a host mute apart. */
  private micIntent = false;
  private mic: MicPipeline | undefined;
  private filePubs: LocalTrackPublication[] = [];
  /** A command we sent that the host has not yet confirmed by its state. */
  private pendingFileCmd: { cmd: FileCommand; sentAt: number; tries: number } | undefined;
  private lastNudge = 0;
  private readonly hostSeedBytes: Uint8Array | undefined;
  private policyRev = 0;
  private hostSeenAt = 0;

  constructor(opts: SessionOptions) {
    this.roomSecret = opts.roomSecret;
    this.hostKey = opts.hostKey;
    this.hostPub = opts.hostPub;
    this.hostSeedBytes = opts.hostKey ? hostSeed(opts.hostKey) : undefined;
    this.controlHost = !!this.hostSeedBytes && !!opts.hostPub;
    this.apiBase = opts.apiBase ?? '/api';
    this.displayName = opts.displayName.slice(0, MAX_NAME_LENGTH);
    this.group = new GroupKeys({
      roomSecret: opts.roomSecret,
      identity: newIdentity(),
      selfIdentity: this.identity,
      displayName: this.displayName,
    });
    if (DIRECT) {
      // No server: browsers connect to each other. Discovery is encrypted
      // under a key derived from the room secret, so a relay cannot join.
      const mesh = new MeshRoom({
        identity: this.identity,
        roomId: opts.roomSecret.roomId,
        password: toB64Url(sha256(concat(utf8('shh-vc/v1/discovery'), opts.roomSecret.secret))),
        relayUrls: RELAY_URLS,
      });
      mesh.onKeyMessage = (from, payload) => void this.onSignal(from, payload);
      mesh.onDiscovery = (online) => {
        this.discoveryOnline.value = online;
      };
      mesh.onProblem = (kind) => {
        if (kind === 'room-full') void this.leave('failed', 'This room is full. Rooms hold six people.');
        else if (kind === 'peer-connect-failed') {
          toast('Could not connect to someone in this room', 'warn',
            'One of you is on a network that blocks direct connections. A different network or a VPN usually fixes it.');
        }
      };
      this.signalCh = {
        connect: async () => undefined,
        send: (payload) => mesh.sendKeyMessage(payload),
        close: () => undefined,
      };
      this.room = mesh as unknown as Room;
    } else {
      this.signalCh = new SignalChannel({
        endpoint: `${this.apiBase}/signal`,
        roomId: opts.roomSecret.roomId,
        identity: this.identity,
        onMessage: (from, payload) => void this.onSignal(from, payload),
      });
      this.worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), {
        type: 'module',
      });
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: cameraPublishOptions(),
        encryption: { keyProvider: this.keyProvider!, worker: this.worker },
      });
    }
    this.audioHost = document.createElement('div');
    this.audioHost.dataset.btAudio = '';
    this.audioHost.hidden = true;
    document.body.append(this.audioHost);
    this.share = new ShareController(this);
    this.link = new PlayerLink(this);
    this.wire();
  }

  // ---- lifecycle -----------------------------------------------------

  async connect(): Promise<void> {
    const grant = DIRECT ? { url: '', token: '', host: false, locked: false } : await this.requestToken();
    this.isHost.value = grant.host;
    this.locked.value = grant.locked;

    // Our own key must exist before any frame is encoded.
    this.group.advance('init');
    await this.applySelfKey();

    // Open the key-agreement channel before media: a participant publishing
    // before it can exchange keys is noise on the wire.
    await this.signalCh.connect();
    await this.room.connect(grant.url, grant.token, { autoSubscribe: true });
    await this.room.setE2EEEnabled(true);
    this.broadcastAnnounce();

    this.timers.push(setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS));
    this.timers.push(setInterval(() => this.sendPresence(), PRESENCE_INTERVAL_MS));
    this.timers.push(setInterval(() => this.sweepTyping(), 1000));
    this.timers.push(setInterval(() => this.tickControl(), 2000));
    if (this.controlHost) this.timers.push(setInterval(() => this.sendPolicy(), POLICY_INTERVAL_MS));

    batch(() => {
      this.status.value = 'connected';
      this.startedAt.value = Date.now();
    });
    this.audioBlocked.value = !this.room.canPlaybackAudio;
    this.refresh();
    play('join');
  }

  async leave(reason: EndReason = 'left', detail?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.onFileCommand = undefined;
    this.localFile.value = undefined;
    this.share.dispose();
    this.link.dispose();
    this.mic?.stop();
    this.mic = undefined;
    this.signalCh.close();
    if (reason === 'left') play('leave');
    batch(() => {
      this.endReason.value = reason;
      this.endDetail.value = detail;
      this.status.value = 'ended';
    });
    try {
      await this.room.disconnect();
    } finally {
      this.worker?.terminate();
      this.worker = undefined;
      this.audioHost.remove();
    }
  }

  private async requestToken(): Promise<{ token: string; url: string; host: boolean; locked: boolean }> {
    const res = await fetch(`${this.apiBase}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A room id (a hash), a random identity, and for the creator a host key.
      // Never the room secret, never a name.
      body: JSON.stringify({
        roomId: this.roomSecret.roomId,
        identity: this.identity,
        ...(this.hostKey ? { hostKey: this.hostKey } : {}),
      }),
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      url?: string;
      host?: boolean;
      locked?: boolean;
      error?: string;
    };
    if (!res.ok || !body.token || !body.url) {
      throw new JoinError(res.status, body.error ?? `The server answered ${res.status}.`);
    }
    return { token: body.token, url: body.url, host: body.host === true, locked: body.locked === true };
  }

  // ---- microphone, camera, deafen ------------------------------------

  private micConstraints() {
    const s = settings.value;
    return {
      ...(s.micId ? { deviceId: s.micId } : {}),
      noiseSuppression: s.suppression === 'standard',
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGain,
    };
  }

  /**
   * The first time the microphone turns on, build the pipeline and publish its
   * output. After that, mute and unmute only toggle the published track; the
   * pipeline keeps running so suppression and device changes are instant.
   */
  private async ensureMic(): Promise<void> {
    if (this.mic) return;
    const s = settings.value;
    const pipeline = new MicPipeline(s.suppression, {
      deviceId: s.micId || undefined,
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGain,
    });
    try {
      await pipeline.start();
      await this.room.localParticipant.publishTrack(pipeline.track, {
        source: Track.Source.Microphone,
        name: 'microphone',
        audioPreset: { maxBitrate: 48_000 },
        red: true,
        dtx: false,
      });
    } catch (err) {
      pipeline.stop();
      throw err;
    }
    this.mic = pipeline;
    this.micSuppression.value = pipeline.mode;
    this.suppressionNote.value = pipeline.fallbackReason;
  }

  /** Switch noise suppression while live. */
  async setSuppression(mode: Suppression): Promise<void> {
    updateSettings({ suppression: mode });
    if (!this.mic) {
      this.micSuppression.value = mode;
      return;
    }
    try {
      await this.mic.setMode(mode);
    } catch (err) {
      toast('Could not change noise suppression', 'warn', mediaErrorText(err, 'microphone'));
    }
    this.micSuppression.value = this.mic.mode;
    this.suppressionNote.value = this.mic.fallbackReason;
    if (this.mic.fallbackReason) toast('Noise suppression', 'warn', this.mic.fallbackReason);
  }

  /** 0–1 level of what the room hears from you, after suppression. */
  micLevel(): number {
    return this.mic && this.micOn.peek() ? this.mic.level() : 0;
  }

  async setMic(on: boolean, silent = false): Promise<void> {
    this.micIntent = on;
    try {
      if (on) await this.ensureMic();
      await this.room.localParticipant.setMicrophoneEnabled(on, this.micConstraints());
      if (!silent) play(on ? 'unmute' : 'mute');
    } catch (err) {
      this.micIntent = false;
      toast('Microphone unavailable', 'error', mediaErrorText(err, 'microphone'));
      play('error');
    }
    this.refresh();
  }

  async setCamera(on: boolean): Promise<void> {
    try {
      const s = settings.value;
      await this.room.localParticipant.setCameraEnabled(
        on,
        { ...(s.camId ? { deviceId: s.camId } : {}), resolution: { width: 1280, height: 720, frameRate: 30 } },
        cameraPublishOptions(),
      );
    } catch (err) {
      toast('Camera unavailable', 'error', mediaErrorText(err, 'camera'));
      play('error');
    }
    this.refresh();
  }

  /**
   * Deafen silences everything coming *in*. It does not touch the microphone:
   * the two are independent, and the UI shows them separately.
   */
  setDeafened(on: boolean): void {
    this.deafened.value = on;
    this.applyVolumes();
    play(on ? 'deafen' : 'undeafen');
    this.sendPresence();
    this.refresh();
  }

  /** Re-acquire the microphone after a processing toggle changed. */
  async applyMicProcessing(): Promise<void> {
    if (!this.mic) return;
    const s = settings.value;
    try {
      await this.mic.setInput({ echoCancellation: s.echoCancellation, autoGainControl: s.autoGain });
    } catch (err) {
      toast('Could not apply that microphone setting', 'warn', describeError(err));
    }
  }

  async setDevice(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    if (kind === 'audioinput') updateSettings({ micId: deviceId });
    if (kind === 'videoinput') updateSettings({ camId: deviceId });
    if (kind === 'audiooutput') updateSettings({ speakerId: deviceId });
    try {
      // The microphone goes through our own pipeline, so it switches there.
      if (kind === 'audioinput') await this.mic?.setInput({ deviceId: deviceId || undefined });
      else await this.room.switchActiveDevice(kind, deviceId);
    } catch (err) {
      toast('Could not switch device', 'warn', describeError(err));
    }
  }

  /** Re-announce our presence, e.g. after the avatar colour changed. */
  presenceChanged(): void {
    this.sendPresence();
    this.refresh();
  }

  setPeerAudio(identity: string, patch: Partial<PeerAudio>): void {
    const current = this.peerAudio.value[identity] ?? { volume: 1, muted: false };
    this.peerAudio.value = { ...this.peerAudio.value, [identity]: { ...current, ...patch } };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    for (const p of this.room.remoteParticipants.values()) {
      const local = this.peerAudio.value[p.identity];
      const v = this.deafened.value || local?.muted ? 0 : (local?.volume ?? 1);
      p.setVolume(v, Track.Source.Microphone);
      p.setVolume(v, Track.Source.ScreenShareAudio);
    }
  }

  async resumeAudio(): Promise<void> {
    await this.room.startAudio();
    this.audioBlocked.value = !this.room.canPlaybackAudio;
  }

  // ---- host controls (enforced by the server, not by courtesy) --------

  async hostAction(action: 'remove' | 'mute' | 'lock' | 'unlock', identity?: string): Promise<boolean> {
    if (!this.hostKey || DIRECT) return false;
    try {
      const res = await fetch(`${this.apiBase}/host`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomSecret.roomId, hostKey: this.hostKey, action, identity }),
        referrerPolicy: 'no-referrer',
      });
      const body = (await res.json().catch(() => ({}))) as { locked?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}.`);
      if (action === 'lock' || action === 'unlock') {
        this.locked.value = body.locked === true;
        this.sendPresence();
        toast(this.locked.value ? 'Room locked' : 'Room unlocked', 'success',
          this.locked.value ? 'Nobody new can join until you unlock it.' : 'Anyone with the link can join again.');
      }
      play('success');
      return true;
    } catch (err) {
      toast('That did not work', 'error', describeError(err));
      play('error');
      return false;
    }
  }

  // ---- encrypted application channel ---------------------------------

  private async sendApp(msg: AppWire, reliable = true): Promise<void> {
    if (this.room.state !== ConnectionState.Connected) throw new Error('not connected');
    const bytes = new TextEncoder().encode(JSON.stringify(msg)) as Uint8Array<ArrayBuffer>;
    await this.room.localParticipant.publishData(bytes, { reliable, topic: APP_TOPIC });
  }

  private sendPresence(): void {
    void this.sendApp(
      {
        t: 'state',
        deafened: this.deafened.value,
        hue: settings.value.hue,
        mrev: this.movieRev,
        ...(this.isHost.value ? { locked: this.locked.value } : {}),
      },
      true,
    ).catch(() => undefined);
  }

  private onApp(payload: Uint8Array, from: RemoteParticipant | undefined): void {
    if (!from) return;
    let msg: AppWire;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload)) as AppWire;
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return;
    const id = from.identity;
    switch (msg.t) {
      case 'msg':
      case 'edit':
      case 'del':
      case 'react': {
        if ('text' in msg && (typeof msg.text !== 'string' || msg.text.length > MAX_MESSAGE_LENGTH * 2)) return;
        if (typeof msg.id !== 'string' || msg.id.length > 40) return;
        const before = this.messages.value;
        const wire = msg.t === 'msg' ? { ...msg, ts: Date.now() } : msg;
        const after = applyChat(before, id, wire);
        if (after === before) return;
        this.messages.value = after;
        if (msg.t === 'msg') {
          this.typingUntil.delete(id);
          this.sweepTyping();
          if (!this.chatVisible.value) this.unread.value++;
          play('receive');
        }
        return;
      }
      case 'typing':
        this.typingUntil.set(id, Date.now() + TYPING_TTL_MS);
        this.sweepTyping();
        return;
      case 'state': {
        this.peerState.set(id, {
          deafened: msg.deafened === true,
          hue: Number.isFinite(msg.hue) ? Math.abs(Math.round(msg.hue)) % 360 : hueFor(id),
        });
        // Only a server-attested host may announce the lock state.
        if (typeof msg.locked === 'boolean' && isHostParticipant(from)) this.locked.value = msg.locked;
        if (typeof msg.mrev === 'number' && msg.mrev > this.movieRev) {
          void this.sendApp({ t: 'movie-req' }).catch(() => undefined);
        }
        this.refresh();
        return;
      }
      case 'stage-react':
        if (typeof msg.emoji === 'string' && msg.emoji.length <= 16) this.showReaction(id, msg.emoji);
        return;
      case 'movie': {
        const state = msg.state;
        if (typeof state !== 'object' || state === null) return;
        const fromHost = this.signedByHost(state, msg.sig);
        if (!mayChange(this.controlLevel.value, fromHost, classifyChange(this.movie.value, state, Date.now()))) return;
        this.adoptMovie(state);
        return;
      }
      case 'movie-req':
        if (this.controlHost) this.sendPolicy();
        if (this.movie.value || this.movieRev > 0) {
          const state = this.currentMovieState();
          void this.sendApp({ t: 'movie', state, ...this.hostSig(state) }).catch(() => undefined);
        }
        return;
      case 'policy':
        if (!isLevel(msg.level) || !Number.isInteger(msg.rev) || msg.rev < this.policyRev) return;
        if (!this.hostPub || !verifyHost(this.hostPub, this.roomSecret.roomId, { level: msg.level, rev: msg.rev }, msg.sig)) return;
        this.policyRev = msg.rev;
        this.hostSeenAt = Date.now();
        this.controlPolicy.value = msg.level;
        this.tickControl();
        return;
      case 'file-state': {
        // Only whoever is actually sharing can describe what they are playing.
        const current = this.fileShow.value;
        if (current && current.host !== id) return;
        if (!from.isScreenShareEnabled && !current) return;
        const position = Number.isFinite(msg.position) ? Math.max(0, msg.position) : 0;
        const pending = this.pendingFileCmd;
        if (pending) {
          // A command can be lost while keys are still settling. Until the
          // host's own state shows it took effect, keep our view and resend.
          const done =
            pending.cmd.action === 'seek'
              ? Math.abs(position - pending.cmd.position) < 6
              : (msg.playing === true) === (pending.cmd.action === 'play');
          if (done || pending.tries >= 6) {
            this.pendingFileCmd = undefined;
          } else {
            if (Date.now() - pending.sentAt > 900) {
              pending.tries++;
              pending.sentAt = Date.now();
              void this.sendApp({ t: 'file-cmd', ...pending.cmd, ...this.hostSig(pending.cmd) }).catch(() => undefined);
            }
            return;
          }
        }
        this.fileShow.value = {
          host: id,
          name: String(msg.name ?? '').slice(0, 120),
          playing: msg.playing === true,
          position,
          duration: Number.isFinite(msg.duration) ? Math.max(0, msg.duration) : 0,
          at: Date.now(),
        };
        return;
      }
      case 'file-end':
        this.pendingFileCmd = undefined;
        if (this.fileShow.value?.host === id) this.fileShow.value = undefined;
        return;
      case 'file-cmd':
        if (this.localFile.value && this.onFileCommand) {
          const { t: _t, sig, ...cmd } = msg;
          if (!mayChange(this.controlLevel.value, this.signedByHost(cmd, sig), msg.action === 'pause' ? 'pause' : 'other')) return;
          if (msg.action === 'seek') {
            if (Number.isFinite(msg.position)) this.onFileCommand({ action: 'seek', position: Math.max(0, msg.position) }, id);
          } else if (msg.action === 'play' || msg.action === 'pause') {
            this.onFileCommand({ action: msg.action }, id);
          }
        }
        return;
      case 'nudge':
        if (msg.kind !== 'pause' && msg.kind !== 'play') return;
        if (this.share.phase.value === 'live') {
          toast(`${this.nameOf(id)} asked you to ${msg.kind}`, 'info', 'They cannot press the button in your shared tab — only you can.');
          play('notify');
        } else if (this.controlHost && (this.movie.value || this.fileShow.value)) {
          toast(`${this.nameOf(id)} asked to ${msg.kind}`, 'info', 'Only you can control playback right now. Press pause if you agree.');
          play('notify');
        }
        return;
    }
  }

  // ---- playing a file for the room -----------------------------------

  /** Choose a file to play for everyone. Stops a screen share first: one or the other. */
  async chooseFile(file: File): Promise<void> {
    if (this.share.phase.value !== 'idle') await this.share.stop(true);
    if (this.movie.value) this.setMovie(null);
    this.localFile.value = file;
  }

  /** Called by the host's player once the file is decoding: stream it to the room. */
  async startFileShow(stream: MediaStream): Promise<void> {
    await this.unpublishFile();
    for (const track of stream.getTracks()) await this.publishFileTrack(track);
    // The browser can add the sound a moment after the picture; publish it when it appears.
    stream.addEventListener('addtrack', (e) => {
      if (this.localFile.value) void this.publishFileTrack(e.track);
    });
    play('shareStart');
    this.refresh();
  }

  private async publishFileTrack(track: MediaStreamTrack): Promise<void> {
    const local = this.room.localParticipant;
    try {
      if (track.kind === 'video') {
        if (this.filePubs.some((p) => p.kind === Track.Kind.Video)) return;
        track.contentHint = 'motion';
        const height = track.getSettings().height ?? 720;
        const maxBitrate = height > 1080 ? 12_000_000 : height > 720 ? 6_000_000 : height > 480 ? 3_500_000 : 1_800_000;
        this.filePubs.push(
          await local.publishTrack(track, {
            source: Track.Source.ScreenShare,
            name: 'file',
            videoCodec: 'vp8',
            simulcast: false,
            backupCodec: false,
            screenShareEncoding: { maxBitrate, maxFramerate: 30 },
            degradationPreference: 'balanced',
          }),
        );
      } else {
        if (this.filePubs.some((p) => p.kind === Track.Kind.Audio)) return;
        this.filePubs.push(
          await local.publishTrack(track, {
            source: Track.Source.ScreenShareAudio,
            name: 'file-audio',
            audioPreset: AudioPresets.musicHighQuality,
            dtx: false,
            red: false,
          }),
        );
      }
    } catch (err) {
      toast('Could not stream the file', 'error', describeError(err));
    }
  }

  private async unpublishFile(): Promise<void> {
    const pubs = this.filePubs;
    this.filePubs = [];
    for (const pub of pubs) {
      if (pub.track) await this.room.localParticipant.unpublishTrack(pub.track, true).catch(() => undefined);
    }
  }

  /** The host reports what its player is doing; everyone's controls follow. */
  publishFileState(state: { playing: boolean; position: number; duration: number }): void {
    const file = this.localFile.value;
    if (!file) return;
    this.fileShow.value = { host: this.identity, name: file.name, ...state, at: Date.now() };
    void this.sendApp({ t: 'file-state', name: file.name, ...state }).catch(() => undefined);
  }

  async stopFileShow(): Promise<void> {
    if (!this.localFile.value) return;
    this.localFile.value = undefined;
    this.fileShow.value = undefined;
    this.onFileCommand = undefined;
    await this.unpublishFile();
    void this.sendApp({ t: 'file-end' }).catch(() => undefined);
    play('shareStop');
    this.refresh();
  }

  /** Anyone may press play, pause or skip. The host's player carries it out. */
  fileCommand(cmd: FileCommand): void {
    const show = this.fileShow.value;
    if (!show) return;
    if (!this.allowed(cmd.action === 'pause' ? 'pause' : 'other')) return;
    if (show.host === this.identity) {
      this.onFileCommand?.(cmd, this.identity);
      return;
    }
    // Reflect it at once so the button does not feel dead while it travels.
    this.fileShow.value = {
      ...show,
      playing: cmd.action === 'seek' ? show.playing : cmd.action === 'play',
      position: cmd.action === 'seek' ? cmd.position : show.position + (show.playing ? (Date.now() - show.at) / 1000 : 0),
      at: Date.now(),
    };
    this.pendingFileCmd = { cmd, sentAt: Date.now(), tries: 0 };
    void this.sendApp({ t: 'file-cmd', ...cmd, ...this.hostSig(cmd) }).catch(() => toast('Could not reach the room', 'warn'));
  }

  /**
   * For a shared tab or window Shh VC cannot press pause — the video lives
   * in another site. This asks the person sharing to do it.
   */
  nudge(kind: 'pause' | 'play'): boolean {
    // Also how someone without permission asks the host.
    const now = Date.now();
    if (now - this.lastNudge < 4000) return false;
    this.lastNudge = now;
    void this.sendApp({ t: 'nudge', kind }).catch(() => undefined);
    play('send');
    return true;
  }

  // ---- chat ----------------------------------------------------------

  async sendMessage(text: string, replyTo?: string): Promise<void> {
    const clean = sanitizeText(text);
    if (!clean) return;
    const wire: ChatWire = { t: 'msg', id: newMessageId(), text: clean, ts: Date.now(), replyTo };
    this.messages.value = setStatus(applyChat(this.messages.value, this.identity, wire), wire.id, 'sending');
    play('send');
    await this.deliver(wire);
  }

  async retryMessage(id: string): Promise<void> {
    const m = this.messages.value.find((x) => x.id === id && x.from === this.identity);
    if (!m) return;
    this.messages.value = setStatus(this.messages.value, id, 'sending');
    await this.deliver({ t: 'msg', id, text: m.text, ts: m.ts, replyTo: m.replyTo });
  }

  private async deliver(wire: Extract<ChatWire, { t: 'msg' }>): Promise<void> {
    try {
      await this.sendApp(wire);
      this.messages.value = setStatus(this.messages.value, wire.id, undefined);
    } catch {
      this.messages.value = setStatus(this.messages.value, wire.id, 'failed');
      play('error');
    }
  }

  async editMessage(id: string, text: string): Promise<void> {
    const wire: ChatWire = { t: 'edit', id, text: sanitizeText(text) };
    if (!wire.text) return;
    const before = this.messages.value;
    this.messages.value = applyChat(before, this.identity, wire);
    try {
      await this.sendApp(wire);
    } catch {
      this.messages.value = before;
      toast('Edit not sent', 'error', 'You appear to be offline.');
    }
  }

  async deleteMessage(id: string): Promise<void> {
    const wire: ChatWire = { t: 'del', id };
    const before = this.messages.value;
    this.messages.value = applyChat(before, this.identity, wire);
    try {
      await this.sendApp(wire);
    } catch {
      this.messages.value = before;
      toast('Delete not sent', 'error', 'You appear to be offline.');
    }
  }

  toggleReaction(id: string, emoji: string): void {
    const m = this.messages.value.find((x) => x.id === id);
    if (!m) return;
    const on = !(m.reactions[emoji] ?? []).includes(this.identity);
    const wire: ChatWire = { t: 'react', id, emoji, on };
    this.messages.value = applyChat(this.messages.value, this.identity, wire);
    void this.sendApp(wire).catch(() => undefined);
  }

  /** Throttled "is typing" signal. Lossy: a dropped one does not matter. */
  notifyTyping(): void {
    const now = Date.now();
    if (now - this.lastTypingSent < 2000) return;
    this.lastTypingSent = now;
    void this.sendApp({ t: 'typing' }, false).catch(() => undefined);
  }

  setChatVisible(visible: boolean): void {
    this.chatVisible.value = visible;
    if (visible) this.unread.value = 0;
  }

  private sweepTyping(): void {
    const now = Date.now();
    for (const [id, until] of this.typingUntil) if (until < now) this.typingUntil.delete(id);
    const next = [...this.typingUntil.keys()];
    const cur = this.typing.value;
    if (next.length !== cur.length || next.some((v, i) => v !== cur[i])) this.typing.value = next;
  }

  // ---- stage reactions -----------------------------------------------

  react(emoji: string): void {
    this.showReaction(this.identity, emoji);
    void this.sendApp({ t: 'stage-react', emoji }, false).catch(() => undefined);
  }

  private showReaction(from: string, emoji: string): void {
    const id = this.reactionSeq++;
    this.reactions.value = [...this.reactions.value.slice(-11), { id, from, emoji, x: 0.2 + Math.random() * 0.6 }];
    setTimeout(() => {
      this.reactions.value = this.reactions.value.filter((r) => r.id !== id);
    }, 3200);
  }

  // ---- watch together ------------------------------------------------

  private currentMovieState(): MovieState {
    const held = this.movie.value;
    if (!held) return { url: '', playing: false, position: 0, rev: this.movieRev, by: this.identity };
    const { receivedAt: _r, countIn: _c, ...rest } = held;
    return { ...rest, position: expectedPosition(held, Date.now()) };
  }

  private adoptMovie(state: MovieState): void {
    if (typeof state !== 'object' || state === null) return;
    if (typeof state.url !== 'string' || typeof state.rev !== 'number') return;
    const own = state.kind === 'own';
    if (own ? state.url !== 'own' : state.url && !/^https?:\/\//i.test(state.url)) return;
    const current = this.movie.value ?? (this.movieRev > 0
      ? { url: '', playing: false, position: 0, rev: this.movieRev, by: '' }
      : undefined);
    if (!shouldAdopt(current, state)) return;
    this.movieRev = state.rev;
    // A shared clock may sit a few seconds below zero: that is the count-in.
    const floor = own ? -10 : 0;
    this.movie.value = state.url
      ? {
          url: state.url,
          playing: state.playing === true,
          position: Number.isFinite(state.position) ? Math.min(Math.max(floor, state.position), 86_400) : 0,
          rev: state.rev,
          by: String(state.by ?? ''),
          receivedAt: Date.now(),
          ...(own
            ? {
                kind: 'own' as const,
                title: typeof state.title === 'string' ? state.title.slice(0, 120) : '',
                ...(typeof state.watch === 'string' && /^\d{1,12}$/.test(state.watch) ? { watch: state.watch } : {}),
                ...(state.playing === true && typeof state.countIn === 'number' && state.countIn > 0
                  ? { countIn: Math.min(state.countIn, 5) }
                  : {}),
              }
            : {}),
        }
      : undefined;
  }

  /**
   * Publish a new shared playback state. Everyone, including us, adopts it.
   * Returns false when the host's rule does not let us make this change.
   */
  setMovie(
    patch: { url?: string; playing?: boolean; position?: number; kind?: 'own'; title?: string; watch?: string; countIn?: number } | null,
  ): boolean {
    const base = this.currentMovieState();
    const fresh = patch !== null && patch.url !== undefined;
    let next: MovieState =
      patch === null
        ? { url: '', playing: false, position: 0, rev: this.movieRev + 1, by: this.identity }
        : {
            ...(fresh ? { url: patch.url! } : base),
            playing: patch.playing ?? (fresh ? false : base.playing),
            position: patch.position ?? (fresh ? 0 : base.position),
            rev: this.movieRev + 1,
            by: this.identity,
          };
    if (patch && 'title' in patch) next.title = patch.title;
    if (patch?.watch !== undefined) next.watch = patch.watch;
    if (patch?.kind) next.kind = patch.kind;
    // A count-in belongs to the press of play that asked for it, never to later changes.
    if (patch?.countIn) next.countIn = patch.countIn;
    else delete next.countIn;
    if (!next.kind) next = { url: next.url, playing: next.playing, position: next.position, rev: next.rev, by: next.by };
    if (!this.allowed(classifyChange(this.movie.value, next, Date.now()))) return false;
    this.adoptMovie(next);
    void this.sendApp({ t: 'movie', state: next, ...this.hostSig(next) }).catch(() =>
      toast('Could not sync playback', 'warn', 'You appear to be offline.'),
    );
    return true;
  }

  // ---- who controls playback ------------------------------------------

  /** Whether the rule in force lets us make this kind of change. */
  allowed(change: Change): boolean {
    return mayChange(this.controlLevel.value, this.controlHost, change);
  }

  /** Host only: choose who may control playback. */
  setControlPolicy(level: ControlLevel): void {
    if (!this.controlHost) return;
    this.policyRev++;
    this.controlPolicy.value = level;
    this.tickControl();
    this.sendPolicy();
  }

  private sendPolicy(): void {
    if (!this.hostSeedBytes) return;
    const payload = { level: this.controlPolicy.value, rev: this.policyRev };
    const sig = signAsHost(this.hostSeedBytes, this.roomSecret.roomId, payload);
    void this.sendApp({ t: 'policy', ...payload, sig }).catch(() => undefined);
  }

  private tickControl(): void {
    const level = effectiveLevel(this.controlPolicy.value, this.hostSeenAt, Date.now(), this.controlHost);
    if (level !== this.controlLevel.value) this.controlLevel.value = level;
  }

  private hostSig(payload: unknown): { sig?: string } {
    if (!this.controlHost || !this.hostSeedBytes) return {};
    return { sig: signAsHost(this.hostSeedBytes, this.roomSecret.roomId, payload) };
  }

  private signedByHost(payload: unknown, sig: unknown): boolean {
    if (!this.hostPub || sig === undefined) return false;
    const ok = verifyHost(this.hostPub, this.roomSecret.roomId, payload, sig);
    if (ok) this.hostSeenAt = Date.now();
    return ok;
  }

  // ---- key agreement -------------------------------------------------

  private async applySelfKey(): Promise<void> {
    await this.keyProvider?.setParticipantKey(this.group.material, this.identity, this.group.keyIndex);
  }

  /**
   * Key agreement is broadcast over a dedicated relay, never over LiveKit's
   * data channel: that channel is encrypted with the very keys being agreed.
   */
  private sendKeyMsg(msg: VeilMessage): void {
    this.signalCh.send(encodeMessage(msg));
  }

  private broadcastAnnounce(): void {
    this.sendKeyMsg(this.group.buildAnnounce());
  }

  private async sendKeyTo(identity: string, force = false): Promise<void> {
    if (!force && this.sentKeyIndex.get(identity) === this.group.keyIndex) return;
    if (!this.group.peer(identity)) return;
    this.sendKeyMsg(await this.group.sealFor(identity));
    this.sentKeyIndex.set(identity, this.group.keyIndex);
  }

  /**
   * join  -> ratchet forward (the joiner cannot read earlier media)
   * leave -> fresh random key (the leaver cannot read later media)
   * Old keyring slots stay populated so in-flight frames keep decrypting.
   */
  private async rotate(reason: RotationReason): Promise<void> {
    this.group.advance(reason);
    this.sentKeyIndex.clear();
    await this.applySelfKey();
    for (const identity of this.group.peerIdentities) await this.sendKeyTo(identity);
    this.refresh();
  }

  /** Messages can be dropped while a peer is still connecting, so keep at it. */
  private async reconcile(): Promise<void> {
    if (this.closed || this.room.state !== ConnectionState.Connected) return;
    const remotes = [...this.room.remoteParticipants.values()];
    if (remotes.some((p) => !this.group.peer(p.identity))) {
      this.broadcastAnnounce();
      return;
    }
    const unkeyed = remotes.filter((p) => !this.keyedPeers.has(p.identity));
    if (unkeyed.length > 0) {
      this.sendKeyMsg(this.group.buildRekeyRequest());
      for (const p of unkeyed) await this.sendKeyTo(p.identity, true);
    }
  }

  private async onAnnounce(msg: AnnounceMessage): Promise<void> {
    const wasKnown = this.group.peer(msg.id) !== undefined;
    const peer = await this.group.acceptAnnounce(msg);
    if (!peer) {
      toast('Rejected an unverified participant', 'warn',
        'Someone tried to join the encrypted group without the room link.');
      return;
    }
    if (!wasKnown) this.broadcastAnnounce();
    await this.sendKeyTo(peer.identity);
    this.refresh();
  }

  private async onSignal(from: string, payload: Uint8Array): Promise<void> {
    const msg = decodeMessage(payload);
    if (!msg || msg.id !== from) return;
    if (msg.t === 'key' && msg.to !== this.identity) return;
    switch (msg.t) {
      case 'announce':
        await this.onAnnounce(msg);
        return;
      case 'key': {
        const opened = await this.group.open(msg);
        if (!opened) return;
        await this.keyProvider?.setParticipantKey(opened.material, opened.from, opened.keyIndex);
        const first = !this.keyedPeers.has(opened.from);
        this.keyedPeers.add(opened.from);
        if (first) {
          // They can now read us, or soon will: tell them who we are.
          setTimeout(() => this.sendPresence(), 400);
          setTimeout(() => void this.sendApp({ t: 'movie-req' }).catch(() => undefined), 900);
        }
        this.refresh();
        return;
      }
      case 'rekey-request':
        await this.sendKeyTo(msg.id, true);
        return;
    }
  }

  // ---- room events ---------------------------------------------------

  private wire(): void {
    const r = this.room;

    r.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic === APP_TOPIC) this.onApp(payload, participant);
    });

    r.on(RoomEvent.ParticipantConnected, () => {
      this.broadcastAnnounce();
      void this.rotate('join');
      play('peerJoin');
    });

    r.on(RoomEvent.ParticipantDisconnected, (p) => {
      this.group.removePeer(p.identity);
      this.keyedPeers.delete(p.identity);
      this.sentKeyIndex.delete(p.identity);
      this.peerState.delete(p.identity);
      this.typingUntil.delete(p.identity);
      if (this.fileShow.value?.host === p.identity) this.fileShow.value = undefined;
      void this.rotate('leave');
      play('peerLeave');
    });

    r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) this.attachAudio(track, participant.identity);
      this.bumpTracks();
    });
    r.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) for (const el of track.detach()) el.remove();
      this.bumpTracks();
    });

    for (const ev of [
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
    ] as const) {
      r.on(ev as RoomEvent.TrackMuted, () => this.bumpTracks());
    }

    r.on(RoomEvent.TrackMuted, (pub, participant) => {
      // The server can mute our microphone on a host's request. Say so.
      if (participant.identity === this.identity && pub.source === Track.Source.Microphone && this.micIntent) {
        this.micIntent = false;
        toast('The host muted your microphone', 'info', 'You can unmute whenever you are ready.');
        play('mute');
      }
    });

    r.on(RoomEvent.ActiveSpeakersChanged, () => this.refresh());
    r.on(RoomEvent.ConnectionQualityChanged, () => this.refresh());
    r.on(RoomEvent.ParticipantMetadataChanged, () => this.refresh());
    r.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      this.audioBlocked.value = !this.room.canPlaybackAudio;
    });

    r.on(RoomEvent.Reconnecting, () => {
      this.status.value = 'reconnecting';
    });
    r.on(RoomEvent.SignalReconnecting, () => {
      this.status.value = 'reconnecting';
    });
    r.on(RoomEvent.Reconnected, () => {
      this.status.value = 'connected';
      toast('Reconnected', 'success');
      void (async () => {
        await this.applySelfKey();
        this.broadcastAnnounce();
        this.sendKeyMsg(this.group.buildRekeyRequest());
        this.sendPresence();
      })();
    });

    r.on(RoomEvent.Disconnected, (reason) => {
      if (this.closed) return;
      const why: EndReason =
        reason === DisconnectReason.PARTICIPANT_REMOVED
          ? 'removed'
          : reason === DisconnectReason.ROOM_DELETED
            ? 'room-closed'
            : 'connection-lost';
      void this.leave(why);
    });

    r.on(RoomEvent.MediaDevicesError, (err) => {
      toast('Device problem', 'error', describeError(err));
    });
  }

  private attachAudio(track: RemoteTrack, identity: string): void {
    const el = track.attach();
    el.dataset.identity = identity;
    this.audioHost.append(el);
    const sink = settings.value.speakerId;
    if (sink && 'setSinkId' in el) {
      void (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(sink).catch(() => undefined);
    }
    this.applyVolumes();
  }

  private bumpTracks(): void {
    this.trackVersion.value++;
    this.refresh();
  }

  /** Recompute the participant list. Cheap: a room holds at most six people. */
  refresh(): void {
    const local = this.room.localParticipant;
    const views: ParticipantView[] = [
      {
        identity: this.identity,
        name: this.displayName,
        hue: settings.value.hue,
        isLocal: true,
        isHost: this.isHost.value,
        code: this.group.selfCode,
        keyed: true,
        micOn: local.isMicrophoneEnabled,
        camOn: local.isCameraEnabled,
        sharing: local.isScreenShareEnabled,
        speaking: local.isSpeaking && local.isMicrophoneEnabled,
        deafened: this.deafened.value,
        quality: qualityOf(local),
        participant: local,
      },
    ];
    for (const p of this.room.remoteParticipants.values()) {
      const peer = this.group.peer(p.identity);
      const state = this.peerState.get(p.identity);
      views.push({
        identity: p.identity,
        name: peer?.displayName ?? '',
        hue: state?.hue ?? hueFor(p.identity),
        isLocal: false,
        isHost: isHostParticipant(p),
        code: this.group.codeFor(p.identity),
        keyed: this.keyedPeers.has(p.identity),
        micOn: p.isMicrophoneEnabled,
        camOn: p.isCameraEnabled,
        sharing: p.isScreenShareEnabled,
        speaking: p.isSpeaking && p.isMicrophoneEnabled,
        deafened: state?.deafened ?? false,
        quality: qualityOf(p),
        participant: p,
      });
    }
    batch(() => {
      this.participants.value = views;
      this.micOn.value = local.isMicrophoneEnabled;
      this.camOn.value = local.isCameraEnabled;
      this.safety.value = { number: this.group.safetyNumber(), selfCode: this.group.selfCode };
    });
  }

  nameOf(identity: string): string {
    if (identity === this.identity) return this.displayName;
    return this.group.peer(identity)?.displayName || 'Someone';
  }
}

export { JoinError, mediaErrorText };
