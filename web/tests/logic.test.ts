import { describe, expect, it } from 'vitest';
import { fitGrid } from '../src/app/layout.ts';
import {
  applyChat,
  type ChatMessage,
  continuesGroup,
  isEmojiOnly,
  isSingleEmoji,
  linkify,
  MAX_MESSAGE_LENGTH,
  sanitizeText,
  setStatus,
} from '../src/chat/store.ts';
import {
  checkMovieUrl,
  expectedPosition,
  planCorrection,
  shouldAdopt,
} from '../src/movie/sync.ts';
import {
  captureShortfall,
  describeQuality,
  maxBitrateFor,
  PRESETS,
  resolveShare,
  surfaceLabel,
  widthFor,
} from '../src/share/presets.ts';
import { assessHealth, parseVideoStats, withBitrate } from '../src/share/stats.ts';

const custom = { height: 1080, fps: 30, bitrate: 'standard', customKbps: 4000 } as const;

describe('share presets', () => {
  it('offers every preset the brief asks for', () => {
    expect(PRESETS.map((p) => p.id).sort()).toEqual(
      ['balanced', 'cinema', 'custom', 'gaming', 'lowbandwidth', 'presentation', 'text'].sort(),
    );
  });

  it('scales bitrate with resolution, frame rate and level', () => {
    const base = maxBitrateFor({ ...custom });
    expect(base).toBe(3_500_000);
    expect(maxBitrateFor({ ...custom, height: 2160 })).toBeGreaterThan(base);
    expect(maxBitrateFor({ ...custom, fps: 60 })).toBeGreaterThan(base);
    expect(maxBitrateFor({ ...custom, fps: 15 })).toBeLessThan(base);
    expect(maxBitrateFor({ ...custom, bitrate: 'low' })).toBe(base / 2);
    expect(maxBitrateFor({ ...custom, bitrate: 'veryhigh' })).toBeGreaterThan(maxBitrateFor({ ...custom, bitrate: 'high' }));
  });

  it('clamps a custom bitrate to a sane range', () => {
    expect(maxBitrateFor({ ...custom, bitrate: 'custom', customKbps: 1 })).toBe(150_000);
    expect(maxBitrateFor({ ...custom, bitrate: 'custom', customKbps: 9_999_999 })).toBe(25_000_000);
    expect(maxBitrateFor({ ...custom, bitrate: 'custom', customKbps: 2500 })).toBe(2_500_000);
  });

  it('tunes text for sharpness and gaming for frame rate', () => {
    const text = resolveShare('text', custom);
    expect(text.contentHint).toBe('text');
    expect(text.degradation).toBe('maintain-resolution');
    const gaming = resolveShare('gaming', custom);
    expect(gaming.quality.fps).toBe(60);
    expect(gaming.degradation).toBe('maintain-framerate');
    expect(resolveShare('lowbandwidth', custom).maxBitrate).toBeLessThan(resolveShare('balanced', custom).maxBitrate);
  });

  it('uses the custom values only for the custom preset', () => {
    const c = { height: 720, fps: 24, bitrate: 'high', customKbps: 4000 } as const;
    expect(resolveShare('custom', c).quality).toEqual(c);
    expect(resolveShare('balanced', c).quality.height).toBe(1080);
    expect(resolveShare('custom', { ...c, bitrate: 'adaptive' }).degradation).toBe('balanced');
  });

  it('describes quality in plain words', () => {
    expect(describeQuality(resolveShare('balanced', custom))).toBe('1080p · 30 fps · up to 3.5 Mbps');
    expect(describeQuality(resolveShare('custom', { ...custom, height: 2160 }))).toContain('4K');
    expect(widthFor(1080)).toBe(1920);
    expect(surfaceLabel('browser')).toBe('Browser tab');
  });

  it('says so when the source cannot deliver what was asked', () => {
    expect(captureShortfall(custom, { height: 1080, frameRate: 30 })).toBeUndefined();
    expect(captureShortfall(custom, { height: 900, frameRate: 30 })).toMatch(/900p/);
    expect(captureShortfall({ ...custom, fps: 60 }, { height: 1080, frameRate: 30 })).toMatch(/30 fps, not 60/);
    expect(captureShortfall(custom, {})).toBeUndefined();
  });
});

describe('webrtc stats parsing', () => {
  const outbound = [
    { id: 'c1', type: 'codec', mimeType: 'video/VP9' },
    { id: 'o1', type: 'outbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 29, bytesSent: 1_000_000, qualityLimitationReason: 'bandwidth', codecId: 'c1', encoderImplementation: 'libvpx' },
    { id: 'r1', type: 'remote-inbound-rtp', kind: 'video', packetsLost: 4, fractionLost: 0.03, roundTripTime: 0.045 },
  ];

  it('reads sender fields', () => {
    const s = parseVideoStats(outbound, 'send', 1000);
    expect(s).toMatchObject({ width: 1920, height: 1080, fps: 29, codec: 'VP9', limitation: 'bandwidth', packetsLost: 4, fractionLost: 0.03, roundTripTime: 0.045 });
  });

  it('reads receiver fields and falls back to the candidate pair for round trip', () => {
    const s = parseVideoStats(
      [
        { id: 'i1', type: 'inbound-rtp', kind: 'video', frameWidth: 1280, frameHeight: 720, framesPerSecond: 24, bytesReceived: 500, packetsLost: 2, framesDropped: 7, jitter: 0.01 },
        { id: 'p1', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.02 },
      ],
      'receive',
      0,
    );
    expect(s).toMatchObject({ width: 1280, height: 720, fps: 24, packetsLost: 2, framesDropped: 7, roundTripTime: 0.02 });
  });

  it('leaves unreported values undefined instead of inventing them', () => {
    const s = parseVideoStats([], 'send', 0);
    expect(s.width).toBeUndefined();
    expect(s.bitrate).toBeUndefined();
    expect(s.roundTripTime).toBeUndefined();
    expect(assessHealth(s)).toBe('unknown');
  });

  it('derives bitrate from two samples and never from one', () => {
    const a = parseVideoStats(outbound, 'send', 1000);
    expect(withBitrate(undefined, a).bitrate).toBeUndefined();
    const b = parseVideoStats([{ ...outbound[1]!, bytesSent: 1_250_000 }], 'send', 2000);
    expect(withBitrate(a, b).bitrate).toBe(2_000_000);
    expect(withBitrate(b, a).bitrate).toBeUndefined();
  });

  it('does not call a still screen unhealthy', () => {
    expect(assessHealth({ at: 0, direction: 'receive', fps: 1, bitrate: 17_000 })).toBe('good');
    expect(assessHealth({ at: 0, direction: 'send', fps: 30, bitrate: 1, fractionLost: 0.2 })).toBe('poor');
    expect(assessHealth({ at: 0, direction: 'send', fps: 30, bitrate: 1, limitation: 'cpu' })).toBe('fair');
  });
});

describe('watch-together sync', () => {
  const held = { url: 'https://x/v.mp4', playing: true, position: 10, rev: 3, by: 'a', receivedAt: 1000 };

  it('advances the expected position only while playing', () => {
    expect(expectedPosition(held, 3000)).toBe(12);
    expect(expectedPosition({ ...held, playing: false }, 3000)).toBe(10);
    expect(expectedPosition(held, 0)).toBe(10);
  });

  it('adopts newer revisions and breaks ties deterministically', () => {
    expect(shouldAdopt(undefined, held)).toBe(true);
    expect(shouldAdopt(held, { ...held, rev: 4 })).toBe(true);
    expect(shouldAdopt(held, { ...held, rev: 2 })).toBe(false);
    expect(shouldAdopt(held, { ...held, by: 'b' })).toBe(true);
    expect(shouldAdopt({ ...held, by: 'b' }, held)).toBe(false);
  });

  it('nudges small drift and seeks large drift', () => {
    expect(planCorrection(10, 10.02, true)).toEqual({ kind: 'rate', rate: 1 });
    expect(planCorrection(10, 9.7, true)).toEqual({ kind: 'rate', rate: 1.06 });
    expect(planCorrection(10, 10.3, true)).toEqual({ kind: 'rate', rate: 0.94 });
    expect(planCorrection(10, 5, true)).toEqual({ kind: 'seek', to: 10 });
    expect(planCorrection(10, 10.5, false)).toEqual({ kind: 'seek', to: 10 });
    expect(planCorrection(10, 10.01, false)).toEqual({ kind: 'none' });
  });

  it('accepts direct links and is honest about sites it cannot control', () => {
    expect(checkMovieUrl('https://example.com/a.mp4', true)).toEqual({ ok: true, url: 'https://example.com/a.mp4' });
    expect(checkMovieUrl('', true).ok).toBe(false);
    expect(checkMovieUrl('not a url', true).ok).toBe(false);
    expect(checkMovieUrl('ftp://x/y.mp4', true).ok).toBe(false);
    expect(checkMovieUrl('javascript:alert(1)', true).ok).toBe(false);
    expect(checkMovieUrl('http://example.com/a.mp4', true).ok).toBe(false);
    expect(checkMovieUrl('http://example.com/a.mp4', false).ok).toBe(true);
    for (const site of ['https://www.youtube.com/watch?v=1', 'https://youtu.be/1', 'https://www.netflix.com/watch/1']) {
      const r = checkMovieUrl(site, true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Share the tab/);
    }
  });
});

describe('chat model', () => {
  const msg = (id: string, text = 'hi', ts = 1000, replyTo?: string) => ({ t: 'msg' as const, id, text, ts, replyTo });
  const seed = (): ChatMessage[] => applyChat(applyChat([], 'alice', msg('1', 'hello')), 'bob', msg('2', 'yo', 2000));

  it('adds messages and ignores duplicates and empties', () => {
    const m = seed();
    expect(m).toHaveLength(2);
    expect(applyChat(m, 'alice', msg('1'))).toBe(m);
    expect(applyChat(m, 'alice', msg('3', '   '))).toBe(m);
  });

  it('truncates oversized text', () => {
    expect(sanitizeText('x'.repeat(MAX_MESSAGE_LENGTH + 500))).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(sanitizeText('a\r\nb')).toBe('a\nb');
  });

  it('lets only the author edit or delete', () => {
    const m = seed();
    expect(applyChat(m, 'bob', { t: 'edit', id: '1', text: 'hacked' })).toBe(m);
    expect(applyChat(m, 'bob', { t: 'del', id: '1' })).toBe(m);
    const edited = applyChat(m, 'alice', { t: 'edit', id: '1', text: 'hello there' });
    expect(edited[0]).toMatchObject({ text: 'hello there' });
    expect(edited[0]!.editedAt).toBeTypeOf('number');
    const deleted = applyChat(edited, 'alice', { t: 'del', id: '1' });
    expect(deleted[0]).toMatchObject({ deleted: true, text: '' });
    expect(applyChat(deleted, 'alice', { t: 'edit', id: '1', text: 'undead' })[0]!.text).toBe('');
  });

  it('toggles reactions per person and rejects non-emoji', () => {
    let m = seed();
    m = applyChat(m, 'bob', { t: 'react', id: '1', emoji: '👍', on: true });
    m = applyChat(m, 'alice', { t: 'react', id: '1', emoji: '👍', on: true });
    expect(m[0]!.reactions['👍']).toEqual(['bob', 'alice']);
    expect(applyChat(m, 'bob', { t: 'react', id: '1', emoji: '👍', on: true })).toBe(m);
    m = applyChat(m, 'bob', { t: 'react', id: '1', emoji: '👍', on: false });
    m = applyChat(m, 'alice', { t: 'react', id: '1', emoji: '👍', on: false });
    expect(m[0]!.reactions).toEqual({});
    expect(applyChat(m, 'bob', { t: 'react', id: '1', emoji: '<b>', on: true })).toBe(m);
    expect(isSingleEmoji('❤️')).toBe(true);
    expect(isSingleEmoji('ab')).toBe(false);
  });

  it('keeps a reply only if its target exists', () => {
    const m = seed();
    expect(applyChat(m, 'bob', msg('3', 're', 3000, '1'))[2]!.replyTo).toBe('1');
    expect(applyChat(m, 'bob', msg('4', 're', 3000, 'nope'))[2]!.replyTo).toBeUndefined();
  });

  it('groups consecutive messages by one author within five minutes', () => {
    const base: ChatMessage = { id: 'a', from: 'x', text: 't', ts: 1_000_000, reactions: {} };
    expect(continuesGroup(base, { ...base, id: 'b', ts: base.ts + 60_000 })).toBe(true);
    expect(continuesGroup(base, { ...base, id: 'b', from: 'y' })).toBe(false);
    expect(continuesGroup(base, { ...base, id: 'b', ts: base.ts + 6 * 60_000 })).toBe(false);
    expect(continuesGroup(base, { ...base, id: 'b', replyTo: 'a' })).toBe(false);
    expect(continuesGroup(undefined, base)).toBe(false);
  });

  it('linkifies without swallowing trailing punctuation', () => {
    expect(linkify('see https://a.example/x, ok')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'https://a.example/x' },
      { kind: 'text', value: ', ok' },
    ]);
    expect(linkify('<script>')).toEqual([{ kind: 'text', value: '<script>' }]);
    expect(linkify('javascript:alert(1)')).toEqual([{ kind: 'text', value: 'javascript:alert(1)' }]);
  });

  it('recognises emoji-only messages and tracks delivery status', () => {
    expect(isEmojiOnly('👍')).toBe(true);
    expect(isEmojiOnly('👍 🎉')).toBe(true);
    expect(isEmojiOnly('ok 👍')).toBe(false);
    expect(setStatus(seed(), '1', 'failed')[0]!.status).toBe('failed');
  });
});

describe('tile grid', () => {
  it('uses wide tiles on a desktop and never overflows', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const f = fitGrid(n, 1300, 760, 12);
      const rows = Math.ceil(n / f.cols);
      expect(f.cols * f.w + (f.cols - 1) * 12).toBeLessThanOrEqual(1300);
      expect(rows * f.h + (rows - 1) * 12).toBeLessThanOrEqual(760);
      expect(f.w / f.h).toBeLessThanOrEqual(16 / 9 + 0.02);
    }
    expect(fitGrid(2, 1300, 760, 12).cols).toBe(2);
    expect(fitGrid(4, 1300, 760, 12).cols).toBe(2);
    expect(fitGrid(6, 1300, 760, 12).cols).toBe(3);
  });

  it('spans the width on a phone', () => {
    const f = fitGrid(4, 374, 720, 8);
    expect(f.cols * f.w).toBeGreaterThan(374 * 0.9);
    const two = fitGrid(2, 374, 720, 8);
    expect(two.cols).toBe(1);
    expect(two.w).toBeGreaterThan(330);
  });

  it('returns nothing for an empty or unsized stage', () => {
    expect(fitGrid(0, 800, 600, 8).w).toBe(0);
    expect(fitGrid(3, 0, 0, 8).w).toBe(0);
  });
});
