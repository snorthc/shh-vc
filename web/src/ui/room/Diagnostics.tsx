import { useEffect, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import type { Track } from 'livekit-client';
import { formatBitrate } from '../../app/util.ts';
import type { RoomSession } from '../../call/session.ts';
import { describeQuality } from '../../share/presets.ts';
import { assessHealth, parseVideoStats, type StatSample, withBitrate } from '../../share/stats.ts';
import { IconButton } from '../components/primitives.tsx';

/** Poll getStats() for a received video track once a second. */
export function useReceiveStats(track: Track | undefined, active: boolean): StatSample | undefined {
  const [sample, setSample] = useState<StatSample | undefined>();
  useEffect(() => {
    if (!track || !active) {
      setSample(undefined);
      return;
    }
    let prev: StatSample | undefined;
    let alive = true;
    const tick = async () => {
      const report = await track.getRTCStatsReport().catch(() => undefined);
      if (!report || !alive) return;
      const entries: Record<string, unknown>[] = [];
      report.forEach((v) => entries.push(v as Record<string, unknown>));
      prev = withBitrate(prev, parseVideoStats(entries, 'receive', Date.now()));
      setSample(prev);
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [track, active]);
  return sample;
}

const dash = '—';
const res = (w?: number, h?: number) => (w && h ? `${w} × ${h}` : dash);
const fps = (v?: number) => (v === undefined ? dash : `${Math.round(v)} fps`);
const ms = (v?: number) => (v === undefined ? dash : `${Math.round(v * 1000)} ms`);

const HEALTH_LABEL = { good: 'Healthy', fair: 'Under pressure', poor: 'Struggling', unknown: 'Measuring' };
const LIMIT_LABEL: Record<string, string> = {
  none: 'Nothing',
  cpu: 'This device’s CPU',
  bandwidth: 'The network',
  other: 'Something else',
};

/**
 * Live numbers for a share, straight from WebRTC statistics. A dash means the
 * browser did not report that value; nothing here is estimated.
 */
export function Diagnostics(props: {
  session: RoomSession;
  mode: 'send' | 'receive';
  receive?: StatSample;
  onClose: () => void;
}) {
  const { session, mode } = props;
  const share = session.share;
  const sample = mode === 'send' ? share.sendStats.value : props.receive;
  const info = share.info.value;
  const applied = share.applied.value;
  const health = assessHealth(sample);
  const status = session.status.value;

  const rows: [string, string][] = [];
  if (mode === 'send') {
    rows.push(['Capturing', `${res(info?.width, info?.height)}${info?.frameRate ? ` · ${Math.round(info.frameRate)} fps` : ''}`]);
    rows.push(['Sending', res(sample?.width, sample?.height)]);
  } else {
    rows.push(['Receiving', res(sample?.width, sample?.height)]);
  }
  rows.push(['Frame rate', fps(sample?.fps)]);
  rows.push(['Bitrate', formatBitrate(sample?.bitrate)]);
  rows.push(['Codec', sample?.codec ?? dash]);
  rows.push([
    'Packet loss',
    sample?.fractionLost !== undefined
      ? `${(sample.fractionLost * 100).toFixed(1)}%`
      : sample?.packetsLost !== undefined
        ? `${sample.packetsLost} packets`
        : dash,
  ]);
  rows.push(['Round trip', ms(sample?.roundTripTime)]);
  if (mode === 'receive') rows.push(['Dropped frames', sample?.framesDropped !== undefined ? String(sample.framesDropped) : dash]);
  if (mode === 'send') {
    rows.push(['Held back by', sample?.limitation ? (LIMIT_LABEL[sample.limitation] ?? sample.limitation) : dash]);
    rows.push(['Audio', share.audioLive.value ? 'Source audio is being sent' : 'No source audio']);
  }
  rows.push(['Connection', status === 'connected' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting' : 'Offline']);

  return (
    <div class="diag" role="region" aria-label="Share diagnostics" data-testid="diagnostics" onPointerDown={(e) => e.stopPropagation()}>
      <div class="diag-head">
        <span class={`diag-health ${health}`}>{HEALTH_LABEL[health]}</span>
        <IconButton label="Close diagnostics" tipPos="left" onClick={props.onClose}>
          <X />
        </IconButton>
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd class="mono" data-stat={k}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {mode === 'send' && applied && <p class="diag-foot">Requested {describeQuality(applied)}</p>}
    </div>
  );
}
