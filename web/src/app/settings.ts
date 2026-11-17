/**
 * User preferences, kept in localStorage.
 *
 * INVARIANT: nothing secret is ever stored here — no room secret, no host key,
 * no media key, no chat. Only harmless preferences (a display name, device
 * ids, volumes, presets).
 */
import { effect, signal } from '@preact/signals';
import type { Suppression } from '../audio/mic.ts';
import type { BitrateLevel, PresetId, ShareQuality } from '../share/presets.ts';

export type LayoutMode = 'presentation' | 'cinema' | 'theatre' | 'social';

export interface Settings {
  name: string;
  /** Avatar hue, 0–359. */
  hue: number;
  sfxEnabled: boolean;
  /** 0–1 */
  sfxVolume: number;
  micId: string;
  camId: string;
  speakerId: string;
  /** Noise suppression engine for the microphone. */
  suppression: Suppression;
  echoCancellation: boolean;
  autoGain: boolean;
  mirrorSelf: boolean;
  joinMuted: boolean;
  joinCameraOff: boolean;
  sharePreset: PresetId;
  shareCustom: ShareQuality & { bitrate: BitrateLevel };
  /** Ask the browser for the source's audio when sharing. */
  shareAudio: boolean;
  layout: LayoutMode;
}

const KEY = 'shhvc.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  hue: Math.floor(Math.random() * 360),
  sfxEnabled: true,
  sfxVolume: 0.6,
  micId: '',
  camId: '',
  speakerId: '',
  suppression: 'strong',
  echoCancellation: true,
  autoGain: true,
  mirrorSelf: true,
  joinMuted: false,
  joinCameraOff: true,
  sharePreset: 'balanced',
  shareCustom: { height: 1080, fps: 30, bitrate: 'standard', customKbps: 4000 },
  shareAudio: false,
  layout: 'presentation',
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings> & { noiseSuppression?: boolean };
    // Earlier versions had a single on/off switch.
    if (!parsed.suppression && parsed.noiseSuppression === false) parsed.suppression = 'off';
    delete parsed.noiseSuppression;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      shareCustom: { ...DEFAULT_SETTINGS.shareCustom, ...(parsed.shareCustom ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const settings = signal<Settings>(
  typeof localStorage === 'undefined' ? { ...DEFAULT_SETTINGS } : load(),
);

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

if (typeof localStorage !== 'undefined') {
  effect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings.value));
    } catch {
      // Private mode or quota: preferences simply do not persist.
    }
  });
}
