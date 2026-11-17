import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Keeps a component mounted while its exit animation plays. */
export function usePresence(open: boolean, exitMs = 200): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(
      () => {
        setMounted(false);
        setClosing(false);
      },
      reduce ? 0 : exitMs,
    );
    return () => clearTimeout(t);
  }, [open]);
  return { mounted: mounted || open, closing: closing && !open };
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery('(max-width: 760px)');

/** Re-render on an interval, e.g. for a call timer. */
export function useTicker(ms: number, active = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return n;
}

/**
 * FLIP: when the keyed children of a container move or resize between
 * renders, animate them from where they were. Layout changes then read as
 * things moving, not as a jump cut.
 */
export function useFlip(deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const rects = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, DOMRect>();
    for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
      const key = el.dataset.flip!;
      const rect = el.getBoundingClientRect();
      next.set(key, rect);
      const prev = rects.current.get(key);
      if (reduce || rect.width === 0) continue;
      if (!prev) {
        el.animate(
          [
            { opacity: 0, transform: 'scale(0.94)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
        continue;
      }
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      const sx = prev.width / rect.width;
      const sy = prev.height / rect.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: 'top left' },
          { transform: 'none', transformOrigin: 'top left' },
        ],
        { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
    }
    rects.current = next;
  }, deps);

  return ref;
}

export function useEvent<K extends keyof WindowEventMap>(
  type: K,
  handler: (e: WindowEventMap[K]) => void,
  active = true,
): void {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(() => {
    if (!active) return;
    const on = (e: WindowEventMap[K]) => saved.current(e);
    window.addEventListener(type, on);
    return () => window.removeEventListener(type, on);
  }, [type, active]);
}

/** iOS-style deceleration: where a flick at this velocity would come to rest. */
function project(velocity: number, rate = 0.994): number {
  return ((velocity / 1000) * rate) / (1 - rate);
}

/**
 * Drag-to-dismiss for bottom sheets. The sheet follows the finger 1:1 and, on
 * release, decides from where the gesture was heading rather than from where
 * it happened to stop. Returns pointer handlers for the grab area.
 */
export function useSheetDrag(
  surface: { current: HTMLElement | null },
  onClose: () => void,
  enabledQuery = '(max-width: 760px)',
) {
  const drag = useRef<{ id: number; startY: number; samples: { y: number; t: number }[] } | null>(null);

  const onPointerDown = (e: PointerEvent) => {
    if (!matchMedia(enabledQuery).matches) return;
    // Capturing the pointer would swallow taps on controls inside the grab area.
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select')) return;
    const el = surface.current;
    if (!el) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    for (const a of el.getAnimations()) a.cancel();
    drag.current = { id: e.pointerId, startY: e.clientY, samples: [{ y: e.clientY, t: e.timeStamp }] };
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const el = surface.current;
    if (!d || !el || e.pointerId !== d.id) return;
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 6) d.samples.shift();
    const dy = e.clientY - d.startY;
    // Pulling up past the top resists instead of stopping dead.
    const y = dy >= 0 ? dy : -Math.pow(-dy, 0.7);
    el.style.transform = `translateY(${y}px)`;
  };

  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    const el = surface.current;
    if (!d || !el || e.pointerId !== d.id) return;
    drag.current = null;
    const first = d.samples[0]!;
    const last = d.samples[d.samples.length - 1]!;
    const velocity = ((last.y - first.y) / Math.max(1, last.t - first.t)) * 1000;
    const dy = Math.max(0, e.clientY - d.startY);
    const height = el.getBoundingClientRect().height;
    el.style.transform = '';
    if (dy < 4) return;

    if (dy + project(velocity) > height * 0.45 && velocity > -200) {
      const ms = Math.min(320, Math.max(140, ((height - dy) / Math.max(Math.abs(velocity), 600)) * 1000));
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: `translateY(${height}px)` }], {
        duration: ms,
        easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)',
        fill: 'forwards',
      }).finished.then(() => {
        el.style.visibility = 'hidden';
        onClose();
      });
      return;
    }
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
      duration: 380,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
