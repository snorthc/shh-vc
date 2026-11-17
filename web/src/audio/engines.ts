/**
 * The neural noise suppressors, loaded only when someone picks one. Code and
 * model weights are bundled with the site; nothing is fetched from elsewhere.
 */
import { GtcrnWorkletNode, loadGtcrn, loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';

const binaries = new Map<string, Promise<ArrayBuffer>>();
const registered = new WeakMap<BaseAudioContext, Set<string>>();

async function register(ctx: AudioContext, url: string): Promise<void> {
  let set = registered.get(ctx);
  if (!set) registered.set(ctx, (set = new Set()));
  if (set.has(url)) return;
  await ctx.audioWorklet.addModule(url);
  set.add(url);
}

export async function createEngine(
  ctx: AudioContext,
  mode: 'light' | 'strong',
): Promise<{ node: AudioNode; destroy?: () => void }> {
  if (mode === 'light') {
    const wasm = binaries.get('rnnoise') ?? loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
    binaries.set('rnnoise', wasm);
    await register(ctx, rnnoiseWorkletUrl);
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: await wasm });
    return { node, destroy: () => (node as unknown as { destroy?: () => void }).destroy?.() };
  }
  const wasm = binaries.get('gtcrn') ?? loadGtcrn({ url: gtcrnWasmUrl });
  binaries.set('gtcrn', wasm);
  await register(ctx, gtcrnWorkletUrl);
  const node = new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary: await wasm });
  return { node, destroy: () => node.destroy() };
}
