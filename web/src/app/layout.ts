export interface Fit {
  cols: number;
  w: number;
  h: number;
}

/**
 * Choose the column count and tile size that fill the space best. Tiles may
 * be anywhere from 3:4 to 16:9 (wider still on a narrow screen), so a phone
 * in portrait gets tiles that span its width and a desktop gets 16:9 ones,
 * instead of letterboxed 16:9 everywhere.
 */
export function fitGrid(n: number, W: number, H: number, gap: number): Fit {
  let best: Fit = { cols: 1, w: 0, h: 0 };
  if (n <= 0 || W <= 0 || H <= 0) return best;
  const maxRatio = W < 600 ? 2.3 : 16 / 9;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (W - gap * (cols - 1)) / cols;
    const cellH = (H - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const ratio = Math.min(maxRatio, Math.max(3 / 4, cellW / cellH));
    const w = Math.min(cellW, cellH * ratio);
    const h = w / ratio;
    if (w * h > best.w * best.h) best = { cols, w: Math.floor(w), h: Math.floor(h) };
  }
  return best;
}
