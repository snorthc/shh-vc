import { AudioLines, Sparkles, Waves, X } from 'lucide-preact';
import { neuralSuppressionSupported, SUPPRESSION_OPTIONS, type Suppression } from '../../audio/mic.ts';

const ICONS: Record<Suppression, typeof Waves> = {
  off: X,
  standard: Waves,
  light: AudioLines,
  strong: Sparkles,
};

/**
 * Noise suppression choice, with a sentence on what each one does. The AI
 * options are disabled, with a reason, where the browser cannot run them.
 */
export function SuppressionPicker(props: {
  value: Suppression;
  onChange: (v: Suppression) => void;
  compact?: boolean;
  note?: string;
}) {
  const neural = neuralSuppressionSupported();
  return (
    <div class={`suppression ${props.compact ? 'compact' : ''}`}>
      <div class="suppression-list" role="radiogroup" aria-label="Noise suppression">
        {SUPPRESSION_OPTIONS.map((o) => {
          const Icon = ICONS[o.id];
          const disabled = !neural && (o.id === 'light' || o.id === 'strong');
          return (
            <button
              type="button"
              role="radio"
              key={o.id}
              class="suppression-opt"
              aria-checked={props.value === o.id}
              disabled={disabled}
              title={disabled ? 'This browser cannot run the AI filters.' : o.summary}
              onClick={() => props.onChange(o.id)}
              data-suppression={o.id}
            >
              <Icon />
              <span class="suppression-text">
                <span class="suppression-name">{o.label}</span>
                {!props.compact && <span class="suppression-sum">{o.summary}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {props.compact && (
        <p class="hint suppression-hint">{SUPPRESSION_OPTIONS.find((o) => o.id === props.value)?.summary}</p>
      )}
      {props.note && (
        <p class="field-error" role="status">
          {props.note}
        </p>
      )}
    </div>
  );
}
