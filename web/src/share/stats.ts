/**
 * WebRTC statistics, read from RTCPeerConnection/RTCRtpSender/Receiver
 * getStats(). Every value shown in the diagnostics panel comes from here; a
 * field the browser does not report stays undefined and is rendered as "—".
 * Nothing is estimated or invented.
 */

export interface StatSample {
  at: number;
  direction: 'send' | 'receive';
  width?: number;
  height?: number;
  fps?: number;
  /** Cumulative bytes, used to derive bitrate between two samples. */
  bytes?: number;
  bitrate?: number;
  packetsLost?: number;
  /** 0–1, sender side only (reported by the remote end). */
  fractionLost?: number;
  /** Seconds. */
  roundTripTime?: number;
  /** Seconds. */
  jitter?: number;
  framesDropped?: number;
  codec?: string;
  /** Why the encoder is holding quality back: 'none' | 'cpu' | 'bandwidth' | 'other'. */
  limitation?: string;
  implementation?: string;
}

type AnyStat = Record<string, unknown> & { type?: string; kind?: string; id?: string };

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Reduce a raw stats report for one video track into the fields we display. */
export function parseVideoStats(
  entries: Iterable<AnyStat>,
  direction: 'send' | 'receive',
  at: number,
): StatSample {
  const list = [...entries];
  const byId = new Map<string, AnyStat>();
  for (const e of list) if (typeof e.id === 'string') byId.set(e.id, e);

  const sample: StatSample = { at, direction };
  const rtpType = direction === 'send' ? 'outbound-rtp' : 'inbound-rtp';
  // With SVC or simulcast there can be several RTP streams; take the largest.
  const rtps = list
    .filter((e) => e.type === rtpType && (e.kind === 'video' || e.mediaType === 'video'))
    .sort((a, b) => (num(b.frameHeight) ?? 0) - (num(a.frameHeight) ?? 0));
  const rtp = rtps[0];
  if (rtp) {
    sample.width = num(rtp.frameWidth);
    sample.height = num(rtp.frameHeight);
    sample.fps = num(rtp.framesPerSecond);
    sample.bytes = rtps.reduce(
      (sum, r) => sum + (num(direction === 'send' ? r.bytesSent : r.bytesReceived) ?? 0),
      0,
    );
    sample.limitation = str(rtp.qualityLimitationReason);
    sample.implementation = str(
      direction === 'send' ? rtp.encoderImplementation : rtp.decoderImplementation,
    );
    const codec = typeof rtp.codecId === 'string' ? byId.get(rtp.codecId) : undefined;
    const mime = str(codec?.mimeType);
    if (mime) sample.codec = mime.replace(/^video\//i, '').toUpperCase();
    if (direction === 'receive') {
      sample.packetsLost = num(rtp.packetsLost);
      sample.jitter = num(rtp.jitter);
      sample.framesDropped = num(rtp.framesDropped);
    }
  }

  if (direction === 'send') {
    const remote = list.find(
      (e) => e.type === 'remote-inbound-rtp' && (e.kind === 'video' || e.mediaType === 'video'),
    );
    if (remote) {
      sample.packetsLost = num(remote.packetsLost);
      sample.fractionLost = num(remote.fractionLost);
      sample.roundTripTime = num(remote.roundTripTime);
      sample.jitter = num(remote.jitter);
    }
  }

  if (sample.roundTripTime === undefined) {
    const pair = list.find(
      (e) => e.type === 'candidate-pair' && (e.nominated === true || e.selected === true),
    );
    sample.roundTripTime = num(pair?.currentRoundTripTime);
  }
  return sample;
}

/** Bitrate needs two samples; returns the newer one with `bitrate` filled in. */
export function withBitrate(prev: StatSample | undefined, next: StatSample): StatSample {
  if (!prev || prev.bytes === undefined || next.bytes === undefined) return next;
  const dt = (next.at - prev.at) / 1000;
  if (dt <= 0 || next.bytes < prev.bytes) return next;
  return { ...next, bitrate: ((next.bytes - prev.bytes) * 8) / dt };
}

export type Health = 'good' | 'fair' | 'poor' | 'unknown';

/** A plain reading of the numbers, for the one-word status in the panel. */
export function assessHealth(s: StatSample | undefined): Health {
  if (!s || (s.fps === undefined && s.bitrate === undefined)) return 'unknown';
  const loss = s.fractionLost ?? 0;
  const rtt = s.roundTripTime ?? 0;
  // Frame rate is deliberately not a signal: a still screen is encoded at a
  // frame or two per second, and that is the encoder being efficient.
  if (loss > 0.08 || rtt > 0.6) return 'poor';
  if (loss > 0.02 || rtt > 0.25 || s.limitation === 'bandwidth' || s.limitation === 'cpu') {
    return 'fair';
  }
  return 'good';
}
