import { useEffect, useRef } from 'preact/hooks';

/**
 * Ambient light: a soft glow behind whatever is being watched, taken from the
 * picture itself. A 32×18 copy of the current frame, blurred heavily by CSS —
 * cheap enough to run during a call, and it makes the screen feel lit by the
 * content rather than boxed in by it.
 */
export function Ambient(props: { find: () => HTMLVideoElement | null | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = () => {
      const v = props.find();
      if (!v || v.readyState < 2 || !v.videoWidth) return;
      try {
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.dataset.lit = '';
      } catch {
        /* a frame that cannot be drawn is simply skipped */
      }
    };
    draw();
    const t = setInterval(draw, still ? 4000 : 450);
    return () => clearInterval(t);
  }, []);
  return <canvas ref={ref} class="ambient" width={32} height={18} aria-hidden="true" />;
}
