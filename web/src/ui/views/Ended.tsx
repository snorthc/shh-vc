import { backToStart, e2eeSupported, ended, pending, rejoin } from '../../app/state.ts';
import { formatDuration } from '../../app/util.ts';
import { Button, Mark } from '../components/primitives.tsx';

const COPY: Record<string, { title: string; body: string }> = {
  left: { title: 'You left the room', body: 'Nothing from the call was stored.' },
  removed: { title: 'The host removed you', body: 'You are no longer in this room.' },
  'room-closed': { title: 'The room has closed', body: 'Everyone has left.' },
  'connection-lost': {
    title: 'The connection was lost',
    body: 'Shh VC could not reconnect. Check your network and rejoin.',
  },
  failed: { title: 'Could not join', body: 'The room could not be reached.' },
};

export function Ended() {
  const info = ended.value;
  const copy = COPY[info?.reason ?? 'left'] ?? COPY.left!;
  const canRejoin = pending.value && info?.reason !== 'removed';
  return (
    <div class="center-view view">
      <div class="center-card">
        <Mark size={28} />
        <h1>{copy.title}</h1>
        <p>
          {copy.body}
          {info && info.seconds > 5 && info.reason === 'left' && (
            <> You were in the room for {formatDuration(info.seconds)}.</>
          )}
        </p>
        <div class="center-actions">
          {canRejoin && (
            <Button variant="primary" size="lg" onClick={rejoin}>
              Rejoin
            </Button>
          )}
          <Button size="lg" variant={canRejoin ? 'default' : 'primary'} onClick={backToStart}>
            Back to start
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Unsupported() {
  return (
    <div class="center-view view">
      <div class="center-card">
        <Mark size={28} />
        <h1>This browser cannot encrypt calls</h1>
        <p>
          Shh VC encrypts every frame before it leaves your device, which needs a browser feature
          this one is missing. Chrome, Edge, Brave, Firefox 117+ and Safari 15.4+ all have it.
        </p>
        <p class="hint">Shh VC will not fall back to an unencrypted call.</p>
        {e2eeSupported() && (
          <div class="center-actions">
            <Button variant="primary" size="lg" onClick={backToStart}>
              Back to start
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
