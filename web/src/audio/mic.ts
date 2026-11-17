/**
 * The microphone, as it is sent.
 *
 *   raw capture ─▶ [noise suppression] ─▶ level meter
 *                                     └─▶ outgoing track
 *
 * The outgoing track never changes while the call runs, so switching
 * suppression, changing device or toggling echo cancellation is seamless: it
 * rewires this graph instead of renegotiating the call.
 *
 * Suppression engines, all open source and served from this site:
 *   off       nothing: the microphone as it is
 *   standard  the browser's built-in noise suppression (WebRTC)
 *   light     RNNoise (Xiph), a small recurrent network, 2018
 *   strong    GTCRN (2024), a grouped convolutional-recurrent network built
 *             for real-time speech enhancement. The same kind of model Krisp
 *             uses, at a fraction of the size.
 *
 * The neural engines replace the browser's own suppression rather than
 * stacking on top of it: two suppressors in a row is a classic cause of
 * watery, robotic voices.
 */

export type Suppression = 'off' | 'standard' | 'light' | 'strong';

export interface SuppressionOption {
  id: Suppression;
  label: string;
  summary: string;
}

export const SUPPRESSION_OPTIONS: SuppressionOption[] = [
  { id: 'off', label: 'Off', summary: 'Your microphone exactly as it is. Best for music and instruments.' },
  { id: 'standard', label: 'Standard', summary: 'The browser’s built-in filter. Removes steady hum; loud noise can make voices sound thin.' },
  { id: 'light', label: 'AI · Light', summary: 'RNNoise, a small neural network. Removes fans and hiss. Very low CPU.' },
  { id: 'strong', label: 'AI · Strong', summary: 'GTCRN, a newer neural model. Removes keyboards, traffic, dogs and chatter while keeping your voice natural.' },
];

export interface MicInput {
  deviceId?: string;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

/** AudioWorklet and WebAssembly are needed for the neural engines. */
export function neuralSuppressionSupported(): boolean {
  return (
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    typeof AudioContext !== 'undefined'
  );
}

type Engine = { node: AudioNode; destroy?: () => void };

let enginesModule: Promise<typeof import('./engines.ts')> | undefined;
const loadEngines = () => (enginesModule ??= import('./engines.ts'));

export class MicPipeline {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  private readonly out: MediaStreamAudioDestinationNode;
  private readonly monitor: GainNode;
  /** Neural filters leave speech about 6 dB quieter; this restores it, then limits peaks. */
  private readonly makeup: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private input: MediaStream | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private engine: Engine | undefined;
  private inputOpts: MicInput;
  private changing: Promise<void> = Promise.resolve();
  mode: Suppression;
  /** Set when a neural engine failed to start and the pipeline fell back. */
  fallbackReason: string | undefined;

  constructor(mode: Suppression, input: MicInput) {
    this.mode = mode;
    this.inputOpts = input;
    this.ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    this.out = this.ctx.createMediaStreamDestination();
    this.out.channelCount = 1;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    this.monitor = this.ctx.createGain();
    this.monitor.gain.value = 0;
    this.monitor.connect(this.ctx.destination);
    this.makeup = this.ctx.createGain();
    this.makeup.gain.value = 2; // +6 dB
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.makeup.connect(this.limiter);
  }

  /** The track to send. It stays the same for the life of the pipeline. */
  get track(): MediaStreamTrack {
    return this.out.stream.getAudioTracks()[0]!;
  }

  /** Settings the browser applied to the raw capture, for display and tests. */
  inputSettings(): MediaTrackSettings | undefined {
    return this.input?.getAudioTracks()[0]?.getSettings();
  }

  async start(): Promise<MediaStreamTrack> {
    await this.serial(async () => {
      if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
      await this.openInput();
      await this.buildEngine();
      this.wire();
    });
    return this.track;
  }

  /** Change suppression while live. Re-captures only if the browser filter flips. */
  setMode(mode: Suppression): Promise<void> {
    return this.serial(async () => {
      if (mode === this.mode && !this.fallbackReason) return;
      const browserFilterFlips = (mode === 'standard') !== (this.mode === 'standard');
      this.mode = mode;
      this.fallbackReason = undefined;
      if (browserFilterFlips) await this.openInput();
      await this.buildEngine();
      this.wire();
    });
  }

  /** New device or processing options: re-capture, keep everything downstream. */
  setInput(input: Partial<MicInput>): Promise<void> {
    return this.serial(async () => {
      this.inputOpts = { ...this.inputOpts, ...input };
      await this.openInput();
      this.wire();
    });
  }

  /** Play your own processed voice back to you (use headphones). */
  setMonitor(on: boolean): void {
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** 0–1, after suppression: what the room hears. */
  level(): number {
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    const rms = Math.sqrt(sum / data.length);
    // Map roughly -60 dBFS..-10 dBFS to 0..1
    const db = 20 * Math.log10(rms + 1e-9);
    return Math.max(0, Math.min(1, (db + 60) / 50));
  }

  stop(): void {
    this.teardownEngine();
    for (const t of this.input?.getTracks() ?? []) t.stop();
    this.input = undefined;
    this.track.stop();
    void this.ctx.close().catch(() => undefined);
  }

  // ---- internals ------------------------------------------------------

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.changing.then(fn, fn);
    this.changing = next.catch(() => undefined);
    return next;
  }

  private async openInput(): Promise<void> {
    // Release the old capture first: while it is open, the browser hands back
    // the same device with the old processing settings, ignoring the new ones.
    this.source?.disconnect();
    for (const t of this.input?.getTracks() ?? []) t.stop();
    this.input = undefined;
    const fresh = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.inputOpts.deviceId ? { deviceId: { exact: this.inputOpts.deviceId } } : {}),
        echoCancellation: this.inputOpts.echoCancellation,
        autoGainControl: this.inputOpts.autoGainControl,
        noiseSuppression: this.mode === 'standard',
        channelCount: 1,
        sampleRate: 48_000,
      },
    });
    this.input = fresh;
    this.source = this.ctx.createMediaStreamSource(fresh);
  }

  private async buildEngine(): Promise<void> {
    this.teardownEngine();
    if (this.mode !== 'light' && this.mode !== 'strong') return;
    if (!neuralSuppressionSupported()) {
      this.fallbackReason = 'This browser cannot run the AI filters, so the standard filter is used.';
      return;
    }
    try {
      const engines = await loadEngines();
      this.engine = await engines.createEngine(this.ctx, this.mode);
    } catch (err) {
      this.engine = undefined;
      this.fallbackReason = `The AI filter could not start (${err instanceof Error ? err.message : String(err)}). Your microphone is sent unfiltered.`;
    }
  }

  private teardownEngine(): void {
    if (!this.engine) return;
    this.engine.node.disconnect();
    this.engine.destroy?.();
    this.engine = undefined;
  }

  private wire(): void {
    if (!this.source) return;
    this.source.disconnect();
    this.engine?.node.disconnect();
    this.limiter.disconnect();
    let head: AudioNode = this.source;
    if (this.engine) {
      this.source.connect(this.engine.node);
      this.engine.node.connect(this.makeup);
      head = this.limiter;
    }
    head.connect(this.out);
    head.connect(this.analyser);
    head.connect(this.monitor);
  }
}
