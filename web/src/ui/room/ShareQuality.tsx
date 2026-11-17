import { DIRECT } from '../../app/mode.ts';
import { settings, updateSettings } from '../../app/settings.ts';
import {
  BITRATE_LEVELS,
  CUSTOM_KBPS_MAX,
  CUSTOM_KBPS_MIN,
  describeQuality,
  FPS,
  HEIGHT_LABEL,
  HEIGHTS,
  type PresetId,
  PRESETS,
  resolveShare,
} from '../../share/presets.ts';
import { Segmented } from '../components/primitives.tsx';

/**
 * Preset and quality controls. Every change is written to settings and then
 * `onChange` applies it to the live capture, so what is shown is what is sent.
 */
export function ShareQuality(props: { onChange?: () => void; compact?: boolean }) {
  const s = settings.value;
  const resolved = resolveShare(s.sharePreset, s.shareCustom);
  const set = (patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch);
    props.onChange?.();
  };
  const custom = (patch: Partial<typeof s.shareCustom>) =>
    set({ shareCustom: { ...s.shareCustom, ...patch } });

  return (
    <div class="quality">
      <div class="preset-list" role="radiogroup" aria-label="Sharing preset">
        {PRESETS.map((p) => (
          <button
            type="button"
            role="radio"
            key={p.id}
            class="preset"
            aria-checked={s.sharePreset === p.id}
            onClick={() => set({ sharePreset: p.id as PresetId })}
            data-preset={p.id}
          >
            <span class="preset-name">{p.label}</span>
            {!props.compact && <span class="preset-sum">{p.summary}</span>}
          </button>
        ))}
      </div>

      {s.sharePreset === 'custom' && (
        <div class="custom-grid">
          <div class="field">
            <span class="label">Resolution</span>
            <Segmented
              label="Resolution"
              value={s.shareCustom.height}
              options={HEIGHTS.map((h) => ({ value: h, label: HEIGHT_LABEL[h] }))}
              onChange={(height) => custom({ height })}
            />
          </div>
          <div class="field">
            <span class="label">Frame rate</span>
            <Segmented
              label="Frame rate"
              value={s.shareCustom.fps}
              options={FPS.map((f) => ({ value: f, label: `${f}` }))}
              onChange={(fps) => custom({ fps })}
            />
          </div>
          <div class="field">
            <span class="label">Bitrate</span>
            <select
              class="select"
              aria-label="Bitrate"
              value={s.shareCustom.bitrate}
              onChange={(e) => custom({ bitrate: (e.target as HTMLSelectElement).value as typeof s.shareCustom.bitrate })}
            >
              {BITRATE_LEVELS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          {s.shareCustom.bitrate === 'custom' && (
            <div class="field">
              <label class="label" for="custom-kbps">
                Ceiling, kbps
              </label>
              <input
                id="custom-kbps"
                class="input mono"
                type="number"
                inputMode="numeric"
                min={CUSTOM_KBPS_MIN}
                max={CUSTOM_KBPS_MAX}
                step={50}
                value={s.shareCustom.customKbps}
                onChange={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  if (Number.isFinite(v)) {
                    custom({ customKbps: Math.min(CUSTOM_KBPS_MAX, Math.max(CUSTOM_KBPS_MIN, Math.round(v))) });
                  }
                }}
              />
            </div>
          )}
        </div>
      )}

      <p class="quality-line">
        <span class="mono" data-testid="quality-line">
          {describeQuality(resolved)}
        </span>
        <span>
          {/* In direct mode the browsers negotiate the codec; diagnostics show which. */}
          {!DIRECT && ` · ${resolved.codec.toUpperCase()}`}
          {s.sharePreset === 'custom' && s.shareCustom.bitrate === 'adaptive' && ' · adapts to the network'}
        </span>
      </p>
      {(resolved.quality.height >= 1440 || resolved.quality.fps === 60) && (
        <p class="hint">
          This is a request. It is only reached if the source, your hardware and everyone’s
          connection can carry it — the live numbers are in the share’s diagnostics.
        </p>
      )}
    </div>
  );
}
