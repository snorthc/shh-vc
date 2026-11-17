/**
 * Voice quality on a direct (browser-to-browser) connection.
 *
 * Browsers default to roughly 30 kbps Opus with no redundancy. On a clean
 * line that is fine; on real Wi-Fi a lost packet has to be guessed by the
 * receiver, and when loss is reported the encoder squeezes itself further to
 * make room for error correction. Both make voices sound robotic.
 *
 * Three changes, all through standard WebRTC:
 *   1. RED: each packet also carries the previous 20 ms of audio, so a single
 *      lost packet is reconstructed exactly instead of being invented.
 *   2. Opus at 48 kbps, with in-band FEC and no DTX, so error correction has
 *      headroom and the voice keeps its full band.
 *   3. Audio goes first: its sender is marked high priority, so when the
 *      connection is congested video gives way, not your voice.
 */

/** Opus settings this browser asks its peers to send with. */
export const OPUS_PARAMS: Record<string, string> = {
  minptime: '10',
  useinbandfec: '1',
  usedtx: '0',
  stereo: '0',
  'sprop-stereo': '0',
  maxplaybackrate: '48000',
  maxaveragebitrate: '48000',
};

/**
 * Rewrite the Opus format parameters in an SDP. Applied to the description a
 * peer sends us, because those parameters tell *our* encoder how to send.
 * Every other line is left exactly as it was.
 */
export function tuneOpusSdp(sdp: string, params: Record<string, string> = OPUS_PARAMS): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const opusPts = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?$/i.exec(line);
    if (m) opusPts.add(m[1]!);
  }
  if (opusPts.size === 0) return sdp;

  const seenFmtp = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const fm = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fm && opusPts.has(fm[1]!)) {
      seenFmtp.add(fm[1]!);
      const merged = new Map<string, string>();
      for (const part of fm[2]!.split(';')) {
        const [k, v] = part.split('=');
        if (k && k.trim()) merged.set(k.trim(), (v ?? '').trim());
      }
      for (const [k, v] of Object.entries(params)) merged.set(k, v);
      out.push(`a=fmtp:${fm[1]} ${[...merged].map(([k, v]) => `${k}=${v}`).join(';')}`);
      continue;
    }
    out.push(line);
    const rm = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (rm && !lines.some((l) => l.startsWith(`a=fmtp:${rm[1]} `))) {
      out.push(`a=fmtp:${rm[1]} ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(';')}`);
      seenFmtp.add(rm[1]!);
    }
  }
  return out.join(eol);
}

/** Codec order for audio: RED first when the browser supports it, then Opus. */
export function preferRed(codecs: RTCRtpCodec[]): RTCRtpCodec[] {
  const red = codecs.filter((c) => /audio\/red/i.test(c.mimeType));
  if (red.length === 0) return codecs;
  const opus = codecs.filter((c) => /audio\/opus/i.test(c.mimeType));
  const rest = codecs.filter((c) => !red.includes(c) && !opus.includes(c));
  return [...red, ...opus, ...rest];
}
