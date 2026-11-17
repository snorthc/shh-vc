import type { ComponentChildren, JSX } from 'preact';
import { avatarColors, initials } from '../../app/util.ts';

type ButtonProps = Omit<JSX.IntrinsicElements['button'], 'size'> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  loading?: boolean;
};

export function Button({ variant = 'default', size = 'md', block, loading, class: cls, children, disabled, ...rest }: ButtonProps) {
  const classes = [
    'btn',
    variant !== 'default' && `btn-${variant}`,
    size !== 'md' && `btn-${size}`,
    block && 'btn-block',
    cls,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" class={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <span class="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

type IconButtonProps = JSX.IntrinsicElements['button'] & {
  label: string;
  tipPos?: 'above' | 'below' | 'left';
  pressed?: boolean;
  btnRef?: { current: HTMLButtonElement | null };
};

export function IconButton({ label, tipPos = 'above', pressed, btnRef, class: cls, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      ref={btnRef}
      class={`icon-btn ${cls ?? ''}`}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      data-tip-pos={tipPos}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      class="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    />
  );
}

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  class?: string;
}) {
  return (
    <div class={`segmented ${props.class ?? ''}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          type="button"
          role="radio"
          key={o.value}
          aria-checked={o.value === props.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider(props: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const min = props.min ?? 0;
  const max = props.max ?? 1;
  const fill = ((props.value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      class="slider"
      min={min}
      max={max}
      step={props.step ?? 0.01}
      value={props.value}
      aria-label={props.label}
      disabled={props.disabled}
      style={{ '--fill': `${fill}%` }}
      onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
      onChange={(e) => props.onCommit?.(Number((e.target as HTMLInputElement).value))}
    />
  );
}

export function Avatar(props: { name: string; hue: number; size?: number; class?: string }) {
  const c = avatarColors(props.hue);
  return (
    <span
      class={`avatar ${props.class ?? ''}`}
      style={{ '--size': `${props.size ?? 36}px`, background: c.bg, color: c.fg }}
      aria-hidden="true"
    >
      {initials(props.name)}
    </span>
  );
}

export function Row(props: { title: string; sub?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="row">
      <div class="grow">
        <div class="row-title">{props.title}</div>
        {props.sub && <div class="row-sub">{props.sub}</div>}
      </div>
      {props.children}
    </div>
  );
}

export function Mark(props: { size?: number }) {
  // Two overlapping voices: the mark is a conversation, not a camera.
  const s = props.size ?? 22;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="4" width="13" height="11" rx="4" fill="var(--bone)" />
      <rect x="8.5" y="9" width="13" height="11" rx="4" fill="var(--brass)" stroke="var(--bg)" stroke-width="1.6" />
    </svg>
  );
}
