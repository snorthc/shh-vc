/**
 * The browser-only half of audio/tuning.ts: an RTCPeerConnection that applies
 * those settings to every call. Kept separate so the pure functions can be
 * tested outside a browser.
 */
import { preferRed, tuneOpusSdp } from './tuning.ts';

function audioCodecs(): RTCRtpCodec[] | undefined {
  try {
    return RTCRtpReceiver.getCapabilities?.('audio')?.codecs;
  } catch {
    return undefined;
  }
}

function preferRedOn(t: RTCRtpTransceiver): void {
  const caps = audioCodecs();
  if (!caps || typeof t.setCodecPreferences !== 'function') return;
  try {
    t.setCodecPreferences(preferRed(caps));
  } catch {
    // Some browsers refuse the list; they keep their own order.
  }
}

async function prioritise(sender: RTCRtpSender): Promise<void> {
  const kind = sender.track?.kind;
  if (kind !== 'audio') return;
  try {
    const p = sender.getParameters();
    if (!p.encodings?.length) return;
    for (const enc of p.encodings) {
      (enc as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string }).priority = 'high';
      (enc as RTCRtpEncodingParameters & { networkPriority?: string }).networkPriority = 'high';
    }
    await sender.setParameters(p);
  } catch {
    // Not supported, or not negotiated yet; tried again once connected.
  }
}

/**
 * An RTCPeerConnection with the voice settings above. Handed to the discovery
 * library as its peer-connection class, so every call in the room uses it.
 */
export class TunedPeerConnection extends RTCPeerConnection {
  constructor(config?: RTCConfiguration) {
    super(config);
    this.addEventListener('connectionstatechange', () => {
      if (this.connectionState === 'connected') for (const s of this.getSenders()) void prioritise(s);
    });
  }

  override addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    const sender = super.addTrack(track, ...streams);
    if (track.kind === 'audio') {
      const t = this.getTransceivers().find((x) => x.sender === sender);
      if (t) preferRedOn(t);
      void prioritise(sender);
    }
    return sender;
  }

  override addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    const t = super.addTransceiver(trackOrKind, init);
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    if (kind === 'audio') preferRedOn(t);
    return t;
  }

  override async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    const tuned = desc?.sdp ? { type: desc.type, sdp: tuneOpusSdp(desc.sdp) } : desc;
    await super.setRemoteDescription(tuned);
    // The answering side's audio transceivers come from the offer; give them
    // the same preference before the answer is written.
    for (const t of this.getTransceivers()) {
      if (t.receiver.track?.kind === 'audio') preferRedOn(t);
    }
  }
}
