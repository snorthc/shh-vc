import { describe, expect, it } from 'vitest';
import { OPUS_PARAMS, preferRed, tuneOpusSdp } from '../src/audio/tuning.ts';

const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
  'a=fmtp:96 x-google-start-bitrate=800',
  '',
].join('\r\n');

const fmtpOf = (sdp: string, pt: string) =>
  Object.fromEntries(
    (sdp.split('\r\n').find((l) => l.startsWith(`a=fmtp:${pt} `)) ?? '')
      .slice(`a=fmtp:${pt} `.length)
      .split(';')
      .map((kv) => kv.split('=')),
  );

describe('Opus SDP tuning', () => {
  it('sets every voice parameter on the Opus line', () => {
    const tuned = tuneOpusSdp(OFFER);
    expect(fmtpOf(tuned, '111')).toEqual(OPUS_PARAMS);
    expect(OPUS_PARAMS.useinbandfec).toBe('1');
    expect(OPUS_PARAMS.usedtx).toBe('0');
    expect(Number(OPUS_PARAMS.maxaveragebitrate)).toBeGreaterThanOrEqual(40_000);
  });

  it('touches nothing else', () => {
    const tuned = tuneOpusSdp(OFFER).split('\r\n');
    const original = OFFER.split('\r\n');
    expect(tuned).toHaveLength(original.length);
    const changed = tuned.filter((l, i) => l !== original[i]);
    expect(changed).toEqual([expect.stringMatching(/^a=fmtp:111 /)]);
    expect(tuned).toContain('a=fmtp:63 111/111');
    expect(tuned).toContain('a=fmtp:96 x-google-start-bitrate=800');
  });

  it('adds a format line when Opus has none', () => {
    const bare = OFFER.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '');
    const tuned = tuneOpusSdp(bare);
    expect(fmtpOf(tuned, '111')).toEqual(OPUS_PARAMS);
    const lines = tuned.split('\r\n');
    expect(lines.indexOf('a=fmtp:111 ' + Object.entries(OPUS_PARAMS).map(([k, v]) => `${k}=${v}`).join(';'))).toBe(
      lines.indexOf('a=rtpmap:111 opus/48000/2') + 1,
    );
  });

  it('is idempotent and leaves SDP without Opus alone', () => {
    const once = tuneOpusSdp(OFFER);
    expect(tuneOpusSdp(once)).toBe(once);
    const videoOnly = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
    expect(tuneOpusSdp(videoOnly)).toBe(videoOnly);
  });

  it('keeps the line endings it was given', () => {
    const lf = OFFER.replace(/\r\n/g, '\n');
    expect(tuneOpusSdp(lf)).not.toContain('\r\n');
  });
});

describe('codec preference', () => {
  const c = (mimeType: string) => ({ mimeType, clockRate: 48000 }) as RTCRtpCodec;

  it('puts redundant audio first, then Opus, then the rest in order', () => {
    const out = preferRed([c('audio/opus'), c('audio/G722'), c('audio/red'), c('audio/PCMU')]);
    expect(out.map((x) => x.mimeType)).toEqual(['audio/red', 'audio/opus', 'audio/G722', 'audio/PCMU']);
  });

  it('changes nothing when the browser has no RED', () => {
    const list = [c('audio/opus'), c('audio/G722')];
    expect(preferRed(list)).toBe(list);
  });
});
