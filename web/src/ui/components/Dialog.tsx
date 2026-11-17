import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { X } from 'lucide-preact';
import { usePresence, useSheetDrag } from './hooks.ts';
import { IconButton } from './primitives.tsx';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ComponentChildren;
  width?: number;
  children: ComponentChildren;
  footer?: ComponentChildren;
  /** Extra class on the dialog surface. */
  class?: string;
  testId?: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal on desktop; a draggable bottom sheet on phones. The sheet follows
 * the finger 1:1, and on release decides from where the gesture was heading,
 * not from where it happened to stop.
 */
export function Dialog(props: DialogProps) {
  const { mounted, closing } = usePresence(props.open, 240);
  const surface = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    restore.current = document.activeElement as HTMLElement | null;
    const el = surface.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el;
    first?.focus({ preventScroll: true });
    return () => restore.current?.focus?.({ preventScroll: true });
  }, [props.open]);

  // Escape closes the dialog wherever focus happens to be, including in the
  // instant before focus has moved inside it. Attached synchronously on commit
  // so there is no window in which a fast keypress is missed.
  useLayoutEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('.menu:not(.closing)')) return; // an open popover closes first
      e.stopPropagation();
      e.preventDefault();
      props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.open]);

  const dragHandlers = useSheetDrag(surface, props.onClose, '(max-width: 640px)');

  if (!mounted) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const nodes = [...(surface.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (n) => n.offsetParent !== null,
    );
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === surface.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      class={`scrim ${closing ? 'closing' : ''}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={surface}
        class={`dialog ${props.class ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        style={props.width ? { '--dialog-w': `${props.width}px` } : undefined}
        onKeyDown={onKeyDown}
        data-testid={props.testId}
      >
        <div class="grabber" {...dragHandlers} aria-hidden="true" />
        <div class="dialog-head">
          <div class="titles">
            <h2 class="dialog-title">{props.title}</h2>
            {props.subtitle && <p class="dialog-sub">{props.subtitle}</p>}
          </div>
          <IconButton label="Close" tipPos="below" onClick={props.onClose}>
            <X />
          </IconButton>
        </div>
        <div class="dialog-body">{props.children}</div>
        {props.footer && <div class="dialog-foot">{props.footer}</div>}
      </div>
    </div>
  );
}
