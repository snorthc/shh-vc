export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).slice(0, 2);
  return parts.map((p) => [...p][0]!.toUpperCase()).join('');
}

/** Stable hue from an opaque identity, for participants who sent none. */
export function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Muted, graphite-friendly avatar colours: fixed lightness and low chroma. */
export function avatarColors(hue: number): { bg: string; fg: string } {
  return { bg: `oklch(0.42 0.045 ${hue})`, fg: `oklch(0.93 0.03 ${hue})` };
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export function formatBitrate(bps: number | undefined): string {
  if (bps === undefined || !Number.isFinite(bps)) return '—';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const isTouch =
  typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches;
