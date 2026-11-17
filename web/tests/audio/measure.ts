/**
 * Audio quality measurement: one browser speaks a real recording, another
 * records exactly what it receives and reads the receiver's WebRTC counters.
 *
 *   concealed %   share of received audio the jitter buffer had to invent
 *                 because packets were missing or late. This is the robotic,
 *                 warbling sound. Under ~1% is inaudible; over ~5% is obvious.
 *   stretched %   share of audio sped up or slowed down to manage the buffer.
 *
 * Usage (needs the serverless test build and a local relay, see harness):
 *   E2E_MODE=direct LOSS=0.05 OUT=/path npx vitest run --config vitest.audio.config.ts
 */
import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { freshSecret, joinRoom, startHarness } from '../e2e/harness.ts';

const SECONDS = Number(process.env.SECONDS ?? 14);
const OUT = process.env.OUT ?? '/tmp/shh-audio';
const LABEL = process.env.LABEL ?? 'run';

test('measure received audio', async () => {
  const h = await startHarness({ audioFile: process.env.AUDIO_FILE ?? 'speech.wav' });
  try {
    const secret = freshSecret();
    const suppression = process.env.SUPPRESSION;
    const talker = await joinRoom(h, secret, 'Talker', { mic: true, ...(suppression ? { settings: { suppression } } : {}) });
    const listener = await joinRoom(h, secret, 'Listener', { mic: false });
    await expect
      .poll(() => listener.page.locator('[data-bt-audio] audio').count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await listener.page.waitForTimeout(1500);

    const result = await listener.page.evaluate(async (seconds) => {
      const s = (window as any).__shh.session.value;
      const p = [...s.room.remoteParticipants.values()][0];
      const pub = p.getTrackPublication('microphone');
      const els = [...document.querySelectorAll('[data-bt-audio] audio')] as HTMLAudioElement[];
      const read = async () => {
        const report: RTCStatsReport = await pub.track.getRTCStatsReport();
        let inbound: any;
        const codecs = new Map<string, string>();
        report.forEach((v: any) => {
          if (v.type === 'inbound-rtp' && v.kind === 'audio') inbound = v;
          if (v.type === 'codec') codecs.set(v.id, v.mimeType);
        });
        return { ...inbound, codec: codecs.get(inbound?.codecId) };
      };
      const start = await read();

      // Record what this browser would play.
      const stream = els[0]!.srcObject as MediaStream;
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start();
      await new Promise((r) => setTimeout(r, seconds * 1000));
      rec.stop();
      await new Promise((r) => (rec.onstop = r));
      const end = await read();
      const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));

      const d = (k: string) => (end?.[k] ?? 0) - (start?.[k] ?? 0);
      const total = d('totalSamplesReceived') || 1;
      return {
        audioElements: els.length,
        codec: end?.codec,
        packetsReceived: d('packetsReceived'),
        packetsLost: d('packetsLost'),
        concealedPct: (100 * d('concealedSamples')) / total,
        silentConcealedPct: (100 * d('silentConcealedSamples')) / total,
        stretchedPct: (100 * (d('insertedSamplesForDeceleration') + d('removedSamplesForAcceleration'))) / total,
        concealmentEvents: d('concealmentEvents'),
        jitterBufferMs: d('jitterBufferEmittedCount') ? (1000 * d('jitterBufferDelay')) / d('jitterBufferEmittedCount') : null,
        fecPackets: d('fecPacketsReceived'),
        bitrateKbps: (8 * d('bytesReceived')) / seconds / 1000,
        webm: btoa(bin),
      };
    }, SECONDS);

    writeFileSync(`${OUT}-${LABEL}.webm`, Buffer.from(result.webm, 'base64'));
    const { webm: _, ...metrics } = result;
    console.log(`AUDIO ${LABEL} ${JSON.stringify(metrics)}`);
    await talker.ctx.close();
    await listener.ctx.close();
  } finally {
    await h.close();
  }
}, 180_000);
