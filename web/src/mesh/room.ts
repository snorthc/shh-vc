/**
 * A room with no media server.
 *
 * Browsers connect straight to each other (WebRTC mesh). They find each other
 * through public Nostr relays, using Trystero: no account, no backend, nothing
 * to host. Offers are encrypted with a key derived from the room secret before
 * they touch a relay, and peers check each other's keys against the DTLS
 * fingerprint, so a relay can neither read the handshake nor insert itself.
 *
 * This class presents the slice of the LiveKit room interface that the rest
 * of the app uses, so everything above it — chat, deafen, screen-share
 * preview, watch-together — works unchanged.
 *
 * The trade, stated plainly in the UI: with direct connections, the people in
 * a room can see each other's IP addresses. Hiding them needs a relay server.
 */
import { getRelaySockets, joinRoom, type Room as DiscoveryRoom } from 'trystero';
import { TunedPeerConnection } from '../audio/tuned-pc.ts';

export const MAX_PEOPLE = 6;

type Source = 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio';
type Handler = (...args: never[]) => void;

interface PubWire {
  source: Source;
  muted: boolean;
}

function kindOf(source: Source): 'audio' | 'video' {
  return source === 'microphone' || source === 'screen_share_audio' ? 'audio' : 'video';
}

class MeshTrack {
  readonly elements = new Set<HTMLMediaElement>();
  isMuted = false;
  volume = 1;

  constructor(
    private readonly room: MeshRoom,
    readonly source: Source,
    public mediaStreamTrack: MediaStreamTrack,
    readonly stream: MediaStream,
    readonly ownerPeerId: string | undefined,
  ) {}

  get kind(): 'audio' | 'video' {
    return kindOf(this.source);
  }

  attach(el?: HTMLMediaElement): HTMLMediaElement {
    const target = el ?? document.createElement(this.kind === 'audio' ? 'audio' : 'video');
    target.autoplay = true;
    if (target.srcObject !== this.stream) target.srcObject = this.stream;
    if (this.kind === 'audio') target.volume = this.volume;
    this.elements.add(target);
    void target.play?.().catch(() => undefined);
    return target;
  }

  detach(el?: HTMLMediaElement): HTMLMediaElement[] | HTMLMediaElement {
    const list = el ? [el] : [...this.elements];
    for (const e of list) {
      if (e.srcObject === this.stream) e.srcObject = null;
      this.elements.delete(e);
    }
    return el ?? list;
  }

  setVolume(v: number): void {
    this.volume = v;
    for (const e of this.elements) e.volume = v;
  }

  /** Every peer connection's sender for this track, behind one object. */
  get sender(): { getParameters(): RTCRtpSendParameters; setParameters(p: RTCRtpSendParameters): Promise<void> } | undefined {
    const senders = this.room.sendersFor(this.mediaStreamTrack);
    const first = senders[0];
    if (!first) return undefined;
    return {
      getParameters: () => first.getParameters(),
      setParameters: async (p) => {
        for (const s of senders) {
          const own = s.getParameters();
          own.encodings.forEach((enc, i) => Object.assign(enc, p.encodings[i] ?? p.encodings[0] ?? {}));
          if (p.degradationPreference) own.degradationPreference = p.degradationPreference;
          await s.setParameters(own).catch(() => undefined);
        }
      },
    };
  }

  async getRTCStatsReport(): Promise<RTCStatsReport | undefined> {
    if (this.ownerPeerId === undefined) return this.room.sendersFor(this.mediaStreamTrack)[0]?.getStats();
    return this.room.receiverFor(this.ownerPeerId, this.mediaStreamTrack)?.getStats();
  }

  async replaceTrack(next: MediaStreamTrack): Promise<this> {
    const old = this.mediaStreamTrack;
    await this.room.swapTrack(old, next);
    this.stream.removeTrack(old);
    this.stream.addTrack(next);
    this.mediaStreamTrack = next;
    if (old !== next) old.stop();
    return this;
  }

  /** Re-acquire the microphone with new constraints. */
  async restartTrack(constraints?: MediaTrackConstraints): Promise<void> {
    if (this.source !== 'microphone') return;
    // Release the device first: while the old track is live the browser hands
    // back the same capture, with the old processing settings.
    this.room.unwatchLevelKeepOwner(this);
    this.mediaStreamTrack.stop();
    const fresh = (await navigator.mediaDevices.getUserMedia({ audio: constraints ?? true })).getAudioTracks()[0]!;
    fresh.enabled = !this.isMuted;
    await this.replaceTrack(fresh);
    this.room.watchLevel(this);
  }
}

class MeshPublication {
  constructor(readonly track: MeshTrack) {}
  readonly isSubscribed = true;
  get source(): Source {
    return this.track.source;
  }
  get kind(): 'audio' | 'video' {
    return this.track.kind;
  }
  get isMuted(): boolean {
    return this.track.isMuted;
  }
  get trackSid(): string {
    return this.track.stream.id;
  }
  get videoTrack(): MeshTrack | undefined {
    return this.kind === 'video' ? this.track : undefined;
  }
  get audioTrack(): MeshTrack | undefined {
    return this.kind === 'audio' ? this.track : undefined;
  }
}

class MeshParticipant {
  readonly trackPublications = new Map<string, MeshPublication>();
  isSpeaking = false;
  audioLevel = 0;
  connectionQuality = 'excellent';
  metadata: string | undefined;

  constructor(
    readonly identity: string,
    readonly peerId: string | undefined,
  ) {}

  get audioTrackPublications(): Map<string, MeshPublication> {
    return new Map([...this.trackPublications].filter(([, p]) => p.kind === 'audio'));
  }

  getTrackPublication(source: Source): MeshPublication | undefined {
    return this.trackPublications.get(source);
  }

  get isMicrophoneEnabled(): boolean {
    const pub = this.trackPublications.get('microphone');
    return !!pub && !pub.isMuted;
  }

  get isCameraEnabled(): boolean {
    return this.trackPublications.has('camera');
  }

  get isScreenShareEnabled(): boolean {
    return this.trackPublications.has('screen_share');
  }

  setVolume(v: number, source: Source = 'microphone'): void {
    this.trackPublications.get(source)?.track.setVolume(v);
  }
}

class MeshLocalParticipant extends MeshParticipant {
  constructor(
    identity: string,
    private readonly room: MeshRoom,
  ) {
    super(identity, undefined);
  }

  async setMicrophoneEnabled(on: boolean, constraints?: MediaTrackConstraints): Promise<MeshPublication | undefined> {
    const existing = this.trackPublications.get('microphone');
    if (!existing) {
      if (!on) return undefined;
      const track = (await navigator.mediaDevices.getUserMedia({ audio: constraints ?? true })).getAudioTracks()[0]!;
      return this.publishTrack(track, { source: 'microphone' });
    }
    existing.track.isMuted = !on;
    existing.track.mediaStreamTrack.enabled = on;
    this.room.announcePublications();
    this.room.emit(on ? 'trackUnmuted' : 'trackMuted', existing, this);
    return existing;
  }

  async setCameraEnabled(
    on: boolean,
    capture?: { deviceId?: string; resolution?: { width: number; height: number; frameRate?: number } },
  ): Promise<MeshPublication | undefined> {
    const existing = this.trackPublications.get('camera');
    if (!on) {
      if (existing) await this.unpublishTrack(existing.track, true);
      return undefined;
    }
    if (existing) return existing;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(capture?.deviceId ? { deviceId: capture.deviceId } : {}),
        width: { ideal: capture?.resolution?.width ?? 1280 },
        height: { ideal: capture?.resolution?.height ?? 720 },
        frameRate: { ideal: capture?.resolution?.frameRate ?? 30 },
      },
    });
    return this.publishTrack(stream.getVideoTracks()[0]!, { source: 'camera' });
  }

  async publishTrack(
    media: MediaStreamTrack,
    opts: { source?: Source; screenShareEncoding?: { maxBitrate?: number; maxFramerate?: number }; degradationPreference?: RTCDegradationPreference } = {},
  ): Promise<MeshPublication> {
    const source: Source = opts.source ?? (media.kind === 'audio' ? 'microphone' : 'camera');
    const previous = this.trackPublications.get(source);
    if (previous) await this.unpublishTrack(previous.track, true);

    const stream = new MediaStream([media]);
    const track = new MeshTrack(this.room, source, media, stream, undefined);
    const pub = new MeshPublication(track);
    this.trackPublications.set(source, pub);
    await this.room.sendStream(stream, source);
    this.room.announcePublications();
    if (source === 'microphone') this.room.watchLevel(track, this);

    // Bitrate ceilings can only be set once a sender exists on each connection.
    const encoding = source === 'camera' ? this.room.cameraEncoding() : opts.screenShareEncoding;
    if (encoding && track.kind === 'video') {
      setTimeout(() => {
        const sender = track.sender;
        if (!sender) return;
        const p = sender.getParameters();
        for (const enc of p.encodings ?? []) Object.assign(enc, encoding);
        if (opts.degradationPreference) p.degradationPreference = opts.degradationPreference;
        void sender.setParameters(p);
      }, 600);
    }
    this.room.emit('localTrackPublished', pub, this);
    return pub;
  }

  async unpublishTrack(target: MeshTrack | MediaStreamTrack, stop = false): Promise<MeshPublication | undefined> {
    const pub = [...this.trackPublications.values()].find(
      (p) => p.track === target || p.track.mediaStreamTrack === target,
    );
    if (!pub) return undefined;
    this.trackPublications.delete(pub.source);
    this.room.dropStream(pub.track.stream);
    this.room.unwatchLevel(pub.track);
    if (stop) pub.track.mediaStreamTrack.stop();
    this.room.announcePublications();
    this.room.emit('localTrackUnpublished', pub, this);
    return pub;
  }

  async publishData(data: Uint8Array, opts: { topic?: string } = {}): Promise<void> {
    await this.room.sendData(opts.topic ?? '', new TextDecoder().decode(data));
  }
}

export interface MeshOptions {
  identity: string;
  roomId: string;
  /** Derived from the room secret. Encrypts discovery so relays cannot read or join. */
  password: string;
  relayUrls?: string[];
}

export class MeshRoom {
  state: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  readonly localParticipant: MeshLocalParticipant;
  readonly remoteParticipants = new Map<string, MeshParticipant>();
  readonly canPlaybackAudio = true;

  private readonly handlers = new Map<string, Set<Handler>>();
  private discovery: DiscoveryRoom | undefined;
  private readonly byPeer = new Map<string, MeshParticipant>();
  private readonly pendingStreams = new Map<string, { stream: MediaStream; source: Source }[]>();
  private readonly pendingPubs = new Map<string, PubWire[]>();
  private readonly meters = new Map<MeshTrack, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; data: Uint8Array<ArrayBuffer>; owner: MeshParticipant; quietSince: number }>();
  /** One audio context for every level meter, rather than one each. */
  private meterCtx: AudioContext | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private send: {
    hello?: (id: string, target?: string) => void;
    pubs?: (list: PubWire[], target?: string) => void;
    app?: (msg: { t: string; d: string }, target?: string) => Promise<void>;
    key?: (text: string) => void;
  } = {};
  /** Key-agreement messages arrive here; the session wires this up. */
  onKeyMessage: ((from: string, payload: Uint8Array) => void) | undefined;
  onProblem: ((kind: 'room-full' | 'peer-connect-failed') => void) | undefined;
  /** Whether any discovery relay is reachable. Without one, nobody new can find the room. */
  onDiscovery: ((online: boolean) => void) | undefined;
  private discoveryOnline: boolean | undefined;

  constructor(private readonly opts: MeshOptions) {
    this.localParticipant = new MeshLocalParticipant(opts.identity, this);
  }

  on(event: string, fn: Handler): this {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(event) ?? []) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`room handler for ${event} threw`, err);
      }
    }
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    const room = joinRoom(
      {
        appId: 'shh-vc.v1',
        password: this.opts.password,
        // A fresh identity per tab: nothing persists that could link two visits.
        identity: 'none',
        maxUsers: MAX_PEOPLE,
        rtcConfig: {
          iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
        },
        // Redundant audio, 64 kbps Opus and voice-first priority: see audio/tuning.ts.
        rtcPolyfill: TunedPeerConnection,
        ...(this.opts.relayUrls?.length ? { relayConfig: { urls: this.opts.relayUrls, redundancy: this.opts.relayUrls.length } } : {}),
      },
      this.opts.roomId,
    );
    this.discovery = room;

    const hello = room.makeAction<string>('hello');
    const pubs = room.makeAction<PubWire[]>('pubs');
    const app = room.makeAction<{ t: string; d: string }>('app');
    const key = room.makeAction<string>('key');
    this.send = {
      hello: (id, target) => void hello.send(id, target ? { target } : undefined).catch(() => undefined),
      pubs: (list, target) => void pubs.send(list, target ? { target } : undefined).catch(() => undefined),
      app: (msg, target) => app.send(msg, target ? { target } : undefined),
      key: (text) => void key.send(text).catch(() => undefined),
    };

    room.onPeerJoin(({ peerId }) => {
      // Tell the newcomer who we are; they do the same. A peer exists for the
      // app only once its hello has arrived.
      this.send.hello?.(this.opts.identity, peerId);
    });

    hello.onMessage((identity, { peerId }) => {
      if (typeof identity !== 'string' || identity.length > 64 || this.byPeer.has(peerId)) return;
      if (this.remoteParticipants.size >= MAX_PEOPLE - 1) return;
      const p = new MeshParticipant(identity, peerId);
      this.byPeer.set(peerId, p);
      this.remoteParticipants.set(identity, p);
      this.emit('participantConnected', p);
      this.retuneCamera();
      // Send them everything we are already publishing.
      for (const pub of this.localParticipant.trackPublications.values()) {
        void room.addStream(pub.track.stream, { target: peerId, metadata: { source: pub.source } }).catch(() => undefined);
      }
      this.announcePublications(peerId);
      for (const s of this.pendingStreams.get(peerId) ?? []) this.addRemoteStream(p, s.stream, s.source);
      this.pendingStreams.delete(peerId);
      const early = this.pendingPubs.get(peerId);
      if (early) this.applyPubs(p, early);
      this.pendingPubs.delete(peerId);
    });

    room.onPeerLeave(({ peerId }) => {
      const p = this.byPeer.get(peerId);
      this.pendingStreams.delete(peerId);
      this.pendingPubs.delete(peerId);
      if (!p) return;
      this.byPeer.delete(peerId);
      this.remoteParticipants.delete(p.identity);
      for (const pub of [...p.trackPublications.values()]) this.removeRemote(p, pub);
      this.emit('participantDisconnected', p);
      this.retuneCamera();
    });

    room.onPeerStream((stream, { peerId, metadata }) => {
      const source = (metadata as { source?: Source } | undefined)?.source;
      if (!source) return;
      const p = this.byPeer.get(peerId);
      if (p) this.addRemoteStream(p, stream, source);
      else this.pendingStreams.set(peerId, [...(this.pendingStreams.get(peerId) ?? []), { stream, source }]);
    });

    pubs.onMessage((list, { peerId }) => {
      if (!Array.isArray(list)) return;
      const p = this.byPeer.get(peerId);
      if (p) this.applyPubs(p, list);
      else this.pendingPubs.set(peerId, list);
    });

    app.onMessage((msg, { peerId }) => {
      const p = this.byPeer.get(peerId);
      if (!p || typeof msg?.d !== 'string') return;
      this.emit('dataReceived', new TextEncoder().encode(msg.d), p, undefined, msg.t);
    });

    key.onMessage((text, { peerId }) => {
      const p = this.byPeer.get(peerId);
      if (p && typeof text === 'string') this.onKeyMessage?.(p.identity, new TextEncoder().encode(text));
    });

    room.onError((err) => {
      if (err.code === 'room-full' || err.code === 'peer-connect-failed') this.onProblem?.(err.code);
    });

    // Without any relay there is nobody to be introduced by. Say so, rather
    // than sitting on "Joining" forever.
    await Promise.race([
      room.ready,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('The public relays that introduce browsers to each other could not be reached. Check your connection, or try another network.')),
          25_000,
        ),
      ),
    ]);
    this.state = 'connected';
    this.timers.push(setInterval(() => this.measure(), 100));
    this.timers.push(setInterval(() => this.checkConnections(), 2000));
    // Give the relays a few seconds before saying they cannot be reached.
    setTimeout(() => this.checkDiscovery(), 6000);
    this.timers.push(setInterval(() => this.checkDiscovery(), 5000));
  }

  private checkDiscovery(): void {
    if (this.state !== 'connected') return;
    const online = Object.values(getRelaySockets()).some((ws) => ws.readyState === WebSocket.OPEN);
    if (online === this.discoveryOnline) return;
    this.discoveryOnline = online;
    this.onDiscovery?.(online);
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const pub of [...this.localParticipant.trackPublications.values()]) pub.track.mediaStreamTrack.stop();
    for (const m of this.meters.values()) m.source.disconnect();
    this.meters.clear();
    void this.meterCtx?.close().catch(() => undefined);
    this.meterCtx = undefined;
    await this.discovery?.leave().catch(() => undefined);
    this.discovery = undefined;
    this.emit('disconnected', undefined);
  }

  // No-ops and small shims so the session code does not need to branch.
  async setE2EEEnabled(): Promise<void> {}
  async startAudio(): Promise<void> {}
  simulateScenario(): void {}

  async switchActiveDevice(kind: MediaDeviceKind, deviceId: string): Promise<boolean> {
    const local = this.localParticipant;
    if (kind === 'audioinput') {
      await local.trackPublications.get('microphone')?.track.restartTrack({ deviceId });
    } else if (kind === 'videoinput' && local.isCameraEnabled) {
      await local.setCameraEnabled(false);
      await local.setCameraEnabled(true, { deviceId });
    } else if (kind === 'audiooutput') {
      for (const p of this.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          for (const el of pub.track.elements) {
            void (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(deviceId);
          }
        }
      }
    }
    return true;
  }

  // ---- used by tracks and the local participant ----------------------

  sendKeyMessage(payload: Uint8Array): void {
    this.send.key?.(new TextDecoder().decode(payload));
  }

  async sendData(topic: string, text: string): Promise<void> {
    if (this.state !== 'connected' || !this.send.app) throw new Error('not connected');
    if (this.byPeer.size === 0) return;
    await this.send.app({ t: topic, d: text });
  }

  async sendStream(stream: MediaStream, source: Source): Promise<void> {
    if (this.byPeer.size === 0) return;
    await this.discovery?.addStream(stream, { target: [...this.byPeer.keys()], metadata: { source } }).catch(() => undefined);
  }

  dropStream(stream: MediaStream): void {
    try {
      this.discovery?.removeStream(stream);
    } catch {
      /* already gone */
    }
  }

  async swapTrack(old: MediaStreamTrack, next: MediaStreamTrack): Promise<void> {
    // Alone in the room there is nothing to swap on the wire yet; the stream
    // itself is updated by the caller and sent to whoever joins next.
    if (this.byPeer.size === 0) return;
    await this.discovery?.replaceTrack(old, next).catch(() => undefined);
  }

  /**
   * On a direct connection you upload one copy of your camera per person, so
   * the per-copy bitrate shrinks as the room grows. That keeps the upload from
   * choking, which is what drags audio down with it.
   */
  cameraEncoding(): { maxBitrate: number; maxFramerate: number } {
    const others = Math.max(1, this.byPeer.size);
    const maxBitrate = others <= 1 ? 1_200_000 : others === 2 ? 800_000 : others === 3 ? 550_000 : 400_000;
    return { maxBitrate, maxFramerate: others >= 4 ? 24 : 30 };
  }

  /** Re-apply the camera ceiling after someone joins or leaves. */
  private retuneCamera(): void {
    const cam = this.localParticipant.trackPublications.get('camera');
    if (!cam) return;
    const enc = this.cameraEncoding();
    setTimeout(() => {
      const sender = cam.track.sender;
      if (!sender) return;
      const p = sender.getParameters();
      for (const e of p.encodings ?? []) Object.assign(e, enc);
      void sender.setParameters(p);
    }, 800);
  }

  announcePublications(target?: string): void {
    const list = [...this.localParticipant.trackPublications.values()].map((p) => ({ source: p.source, muted: p.isMuted }));
    this.send.pubs?.(list, target);
  }

  private connections(): RTCPeerConnection[] {
    return Object.values(this.discovery?.getPeers() ?? {})
      .map((p) => p.connection)
      .filter((c): c is RTCPeerConnection => !!c);
  }

  sendersFor(track: MediaStreamTrack): RTCRtpSender[] {
    return this.connections()
      .map((c) => c.getSenders().find((s) => s.track === track))
      .filter((s): s is RTCRtpSender => !!s);
  }

  receiverFor(peerId: string, track: MediaStreamTrack): RTCRtpReceiver | undefined {
    return this.discovery?.getPeers()[peerId]?.connection?.getReceivers().find((r) => r.track === track);
  }

  // ---- remote media --------------------------------------------------

  private addRemoteStream(p: MeshParticipant, stream: MediaStream, source: Source): void {
    const media = kindOf(source) === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    if (!media) return;
    const existing = p.trackPublications.get(source);
    if (existing) this.removeRemote(p, existing);
    const track = new MeshTrack(this, source, media, stream, p.peerId);
    const pub = new MeshPublication(track);
    p.trackPublications.set(source, pub);
    if (source === 'microphone') this.watchLevel(track, p);
    this.emit('trackPublished', pub, p);
    this.emit('trackSubscribed', track, pub, p);
  }

  private removeRemote(p: MeshParticipant, pub: MeshPublication): void {
    if (p.trackPublications.get(pub.source) === pub) p.trackPublications.delete(pub.source);
    this.unwatchLevel(pub.track);
    this.emit('trackUnsubscribed', pub.track, pub, p);
    this.emit('trackUnpublished', pub, p);
  }

  /** The sender's own list is the truth about what is live and what is muted. */
  private applyPubs(p: MeshParticipant, list: PubWire[]): void {
    const live = new Map(list.filter((x) => typeof x?.source === 'string').map((x) => [x.source, x.muted === true]));
    for (const pub of [...p.trackPublications.values()]) {
      if (!live.has(pub.source)) {
        this.removeRemote(p, pub);
        continue;
      }
      const muted = live.get(pub.source)!;
      if (pub.track.isMuted !== muted) {
        pub.track.isMuted = muted;
        this.emit(muted ? 'trackMuted' : 'trackUnmuted', pub, p);
      }
    }
  }

  // ---- voice activity and connection health --------------------------

  watchLevel(track: MeshTrack, owner?: MeshParticipant): void {
    const prev = this.meters.get(track);
    const who = owner ?? prev?.owner;
    prev?.source.disconnect();
    if (!who) return;
    try {
      this.meterCtx ??= new AudioContext();
      const ctx = this.meterCtx;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      source.connect(analyser);
      this.meters.set(track, { source, analyser, data: new Uint8Array(analyser.fftSize), owner: who, quietSince: 0 });
    } catch {
      /* no Web Audio: speaking indicators simply stay off */
    }
  }

  /** Stop metering a track but remember whose it is, for a restart. */
  unwatchLevelKeepOwner(track: MeshTrack): void {
    this.meters.get(track)?.source.disconnect();
  }

  unwatchLevel(track: MeshTrack): void {
    const m = this.meters.get(track);
    if (!m) return;
    m.source.disconnect();
    this.meters.delete(track);
    m.owner.audioLevel = 0;
    m.owner.isSpeaking = false;
  }

  private measure(): void {
    let changed = false;
    const now = Date.now();
    for (const [track, m] of this.meters) {
      m.analyser.getByteTimeDomainData(m.data);
      let peak = 0;
      for (const v of m.data) peak = Math.max(peak, Math.abs(v - 128) / 128);
      const level = track.isMuted ? 0 : peak;
      m.owner.audioLevel = level;
      if (level > 0.06) m.quietSince = now;
      const speaking = now - m.quietSince < 450 && m.quietSince !== 0;
      if (speaking !== m.owner.isSpeaking) {
        m.owner.isSpeaking = speaking;
        changed = true;
      }
    }
    if (changed) this.emit('activeSpeakersChanged', []);
  }

  private checkConnections(): void {
    let changed = false;
    const peers = this.discovery?.getPeers() ?? {};
    for (const [peerId, p] of this.byPeer) {
      const conn = peers[peerId]?.connection;
      const state = conn?.connectionState;
      const quality = state === 'connected' || state === undefined ? 'excellent' : state === 'disconnected' ? 'lost' : state === 'failed' ? 'lost' : 'good';
      if (state === 'failed') conn?.restartIce?.();
      if (quality !== p.connectionQuality) {
        p.connectionQuality = quality;
        changed = true;
      }
    }
    if (changed) this.emit('connectionQualityChanged');
  }
}
