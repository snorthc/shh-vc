import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { usePresence } from './hooks.ts';

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The element the popover grows out of. */
  anchor: { current: HTMLElement | null };
  placement?: 'above' | 'below';
  align?: 'center' | 'start' | 'end';
  label: string;
  children: ComponentChildren;
  class?: string;
  testId?: string;
}

/**
 * A floating panel anchored to its trigger. It scales from the trigger's
 * position, so it is obvious where it came from and where it goes back to.
 */
export function Popover(props: PopoverProps) {
  const { mounted, closing } = usePresence(props.open, 150);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    if (!props.open) return;
    const place = () => {
      const anchor = props.anchor.current;
      const el = ref.current;
      if (!anchor || !el) return;
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const margin = 8;
      let placement = props.placement ?? 'above';
      if (placement === 'above' && a.top - h - margin < 8) placement = 'below';
      if (placement === 'below' && a.bottom + h + margin > innerHeight - 8 && a.top - h - margin >= 8) placement = 'above';
      const align = props.align ?? 'center';
      let left = align === 'start' ? a.left : align === 'end' ? a.right - w : a.left + a.width / 2 - w / 2;
      left = Math.min(innerWidth - w - 8, Math.max(8, left));
      const top = placement === 'above' ? a.top - h - margin : a.bottom + margin;
      const ox = Math.min(w, Math.max(0, a.left + a.width / 2 - left));
      setPos({
        left,
        top: Math.max(8, top),
        origin: `${ox}px ${placement === 'above' ? '100%' : '0%'}`,
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || props.anchor.current?.contains(t)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
        props.anchor.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('.menu-item:not(:disabled)') ?? [])];
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next]!.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [props.open]);

  if (!mounted) return null;
  return (
    <div
      ref={ref}
      class={`menu ${closing ? 'closing' : ''} ${props.class ?? ''}`}
      role="menu"
      aria-label={props.label}
      data-testid={props.testId}
      style={{
        left: `${pos?.left ?? 0}px`,
        top: `${pos?.top ?? 0}px`,
        visibility: pos ? 'visible' : 'hidden',
        '--origin': pos?.origin,
      }}
    >
      {props.children}
    </div>
  );
}

export function MenuItem(props: {
  icon?: ComponentChildren;
  label: string;
  sub?: string;
  trailing?: ComponentChildren;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      class={`menu-item ${props.danger ? 'danger' : ''}`}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.icon}
      <span class="grow">
        {props.label}
        {props.sub && <span class="sub">{props.sub}</span>}
      </span>
      {props.trailing}
    </button>
  );
}
