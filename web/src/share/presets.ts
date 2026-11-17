/**
 * Screen-share quality model.
 *
 * Everything here maps to something the browser actually does:
 *   height/fps   -> MediaStreamTrack.applyConstraints (capture)
 *   bitrate/fps  -> RTCRtpSender.setParameters encodings (transmission)
 *   contentHint  -> MediaStreamTrack.contentHint (encoder tuning)
 *   degradation  -> RTCRtpSender degradationPreference (what to give up first)
 *
 * A request is only a request: the source may be smaller than the chosen
 * resolution, the display may refresh slower than the chosen frame rate, and
 * the network may not carry the chosen bitrate. The diagnostics panel shows
 * what is really being captured and sent.
 */

export type ShareHeight = 480 | 720 | 1080 | 1440 | 2160;
export type ShareFps = 15 | 24 | 30 | 60;
export type BitrateLevel = 'low' | 'standard' | 'high' | 'veryhigh' | 'adaptive' | 'custom';
export type PresetId =
  | 'text'
  | 'presentation'
  | 'cinema'
  | 'gaming'
  | 'balanced'
  | 'lowbandwidth'
  | 'custom';

export interface ShareQuality {
  height: ShareHeight;
  fps: ShareFps;
  bitrate: BitrateLevel;
  /** Only used when bitrate is 'custom'. */
  customKbps: number;
}

export interface SharePreset {
  id: PresetId;
  label: string;
  summary: string;
  quality: ShareQuality;
  contentHint: '' | 'detail' | 'text' | 'motion';
  degradation: RTCDegradationPreference;
  /** VP9 is sharper on static content; VP8 is cheaper to encode at high frame rates. */
  codec: 'vp9' | 'vp8';
}

export const HEIGHTS: ShareHeight[] = [480, 720, 1080, 1440, 2160];
export const FPS: ShareFps[] = [15, 24, 30, 60];
export const BITRATE_LEVELS: { id: BitrateLevel; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'standard', label: 'Standard' },
  { id: 'high', label: 'High' },
  { id: 'veryhigh', label: 'Very high' },
  { id: 'adaptive', label: 'Adaptive' },
  { id: 'custom', label: 'Custom' },
];

export const HEIGHT_LABEL: Record<ShareHeight, string> = {
  480: '480p',
  720: '720p',
  1080: '1080p',
  1440: '1440p',
  2160: '4K',
};

export const PRESETS: SharePreset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    summary: 'A sensible default for mixed content.',
    quality: { height: 1080, fps: 30, bitrate: 'standard', customKbps: 4000 },
    contentHint: '',
    degradation: 'balanced',
    codec: 'vp9',
  },
  {
    id: 'text',
    label: 'Text & code',
    summary: 'Sharp edges and readable small text. Gives up smoothness first.',
    quality: { height: 1080, fps: 15, bitrate: 'high', customKbps: 4000 },
    contentHint: 'text',
    degradation: 'maintain-resolution',
    codec: 'vp9',
  },
  {
    id: 'presentation',
    label: 'Presentation',
    summary: 'Slides and documents. Readable, and light on bandwidth.',
    quality: { height: 1080, fps: 15, bitrate: 'standard', customKbps: 4000 },
    contentHint: 'detail',
    degradation: 'maintain-resolution',
    codec: 'vp9',
  },
  {
    id: 'cinema',
    label: 'Cinema',
    summary: 'Film and series. Smooth motion at high picture quality.',
    quality: { height: 1080, fps: 30, bitrate: 'veryhigh', customKbps: 4000 },
    contentHint: 'motion',
    degradation: 'balanced',
    codec: 'vp8',
  },
  {
    id: 'gaming',
    label: 'Gaming & motion',
    summary: 'Frame rate first. Lowers resolution before it drops frames.',
    quality: { height: 1080, fps: 60, bitrate: 'adaptive', customKbps: 4000 },
    contentHint: 'motion',
    degradation: 'maintain-framerate',
    codec: 'vp8',
  },
  {
    id: 'lowbandwidth',
    label: 'Low bandwidth',
    summary: 'Keeps the share usable on a weak connection.',
    quality: { height: 720, fps: 15, bitrate: 'low', customKbps: 4000 },
    contentHint: 'detail',
    degradation: 'balanced',
    codec: 'vp9',
  },
  {
    id: 'custom',
    label: 'Custom',
    summary: 'Choose resolution, frame rate and bitrate yourself.',
    quality: { height: 1080, fps: 30, bitrate: 'standard', customKbps: 4000 },
    contentHint: '',
    degradation: 'balanced',
    codec: 'vp9',
  },
];

export function presetById(id: PresetId): SharePreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
}

/** Standard bitrate at 30 fps, in bits per second. */
const BASE_BPS: Record<ShareHeight, number> = {
  480: 1_000_000,
  720: 2_000_000,
  1080: 3_500_000,
  1440: 6_000_000,
  2160: 10_000_000,
};

const FPS_FACTOR: Record<ShareFps, number> = { 15: 0.6, 24: 0.85, 30: 1, 60: 1.5 };

const LEVEL_FACTOR: Record<Exclude<BitrateLevel, 'custom'>, number> = {
  low: 0.5,
  standard: 1,
  high: 1.5,
  veryhigh: 2.25,
  // Adaptive caps at the standard rate and lets congestion control move freely below it.
  adaptive: 1,
};

export const CUSTOM_KBPS_MIN = 150;
export const CUSTOM_KBPS_MAX = 25_000;

/** The encoder's bitrate ceiling for a quality choice, in bits per second. */
export function maxBitrateFor(q: ShareQuality): number {
  if (q.bitrate === 'custom') {
    const kbps = Math.min(CUSTOM_KBPS_MAX, Math.max(CUSTOM_KBPS_MIN, Math.round(q.customKbps)));
    return kbps * 1000;
  }
  return Math.round(BASE_BPS[q.height] * FPS_FACTOR[q.fps] * LEVEL_FACTOR[q.bitrate]);
}

export function widthFor(height: ShareHeight): number {
  return Math.round((height * 16) / 9);
}

export interface ResolvedShare {
  preset: SharePreset;
  quality: ShareQuality;
  maxBitrate: number;
  contentHint: SharePreset['contentHint'];
  degradation: RTCDegradationPreference;
  codec: 'vp9' | 'vp8';
}

/** Resolve a preset (or the user's custom values) into concrete parameters. */
export function resolveShare(
  presetId: PresetId,
  custom: ShareQuality,
): ResolvedShare {
  const preset = presetById(presetId);
  const quality = presetId === 'custom' ? custom : preset.quality;
  const motion = quality.fps >= 30;
  return {
    preset,
    quality,
    maxBitrate: maxBitrateFor(quality),
    contentHint: presetId === 'custom' ? (motion ? 'motion' : 'detail') : preset.contentHint,
    degradation:
      presetId === 'custom'
        ? quality.bitrate === 'adaptive'
          ? 'balanced'
          : motion
            ? 'maintain-framerate'
            : 'maintain-resolution'
        : preset.degradation,
    codec: presetId === 'custom' ? (quality.fps >= 60 ? 'vp8' : 'vp9') : preset.codec,
  };
}

/** One-line description, e.g. "1080p · 30 fps · up to 3.5 Mbps". */
export function describeQuality(r: ResolvedShare): string {
  const mbps = r.maxBitrate / 1_000_000;
  const rate = mbps >= 1 ? `${mbps.toFixed(mbps % 1 === 0 ? 0 : 1)} Mbps` : `${Math.round(r.maxBitrate / 1000)} kbps`;
  return `${HEIGHT_LABEL[r.quality.height]} · ${r.quality.fps} fps · up to ${rate}`;
}

export type DisplaySurface = 'monitor' | 'window' | 'browser' | 'unknown';

export function surfaceLabel(surface: DisplaySurface): string {
  switch (surface) {
    case 'monitor':
      return 'Entire screen';
    case 'window':
      return 'Application window';
    case 'browser':
      return 'Browser tab';
    default:
      return 'Selected source';
  }
}

/**
 * What the capture actually delivered compared with what was asked for.
 * Returns undefined when they match closely enough not to be worth a note.
 */
export function captureShortfall(
  requested: ShareQuality,
  actual: { height?: number; frameRate?: number },
): string | undefined {
  const notes: string[] = [];
  if (actual.height && actual.height < requested.height * 0.9) {
    notes.push(
      `the source is ${actual.height}p, so ${HEIGHT_LABEL[requested.height]} cannot be reached`,
    );
  }
  if (actual.frameRate && actual.frameRate < requested.fps * 0.8) {
    notes.push(`it is delivering ${Math.round(actual.frameRate)} fps, not ${requested.fps}`);
  }
  if (notes.length === 0) return undefined;
  const text = notes.join(', and ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}
