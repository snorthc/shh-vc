import { useRef, useState } from 'preact/hooks';
import { FileVideo, Link2, PanelTop } from 'lucide-preact';
import type { RoomSession } from '../../call/session.ts';
import { checkMovieUrl } from '../../movie/sync.ts';
import { filePlaybackSupported, screenShareSupported } from '../../share/support.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Button } from '../components/primitives.tsx';

export function VerifyDialog(props: { session: RoomSession; open: boolean; onClose: () => void }) {
  const { session } = props;
  const safety = session.safety.value;
  const people = session.participants.value;
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Verify encryption"
      subtitle="Read this number aloud. If everyone sees the same one, nobody has been swapped into the encrypted group."
      testId="verify"
      footer={
        <Button variant="primary" onClick={props.onClose}>
          Done
        </Button>
      }
    >
      <div class="safety mono" data-testid="safety-number">
        {safety.number || '—'}
      </div>
      <p class="hint">
        The number changes whenever someone joins or leaves — that is expected. If yours differs from
        someone else’s, the call may be intercepted: leave and start a new room.
      </p>
      <ul class="codes">
        {people.map((p) => (
          <li key={p.identity}>
            <span>
              {p.name || 'Joining…'}
              {p.isLocal && ' (you)'}
            </span>
            <span class="mono">{p.code ?? 'not verified yet'}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function WatchDialog(props: {
  session: RoomSession;
  open: boolean;
  onClose: () => void;
  /** Start a tab share tuned for video, with audio. */
  onShareTab: () => void;
}) {
  const { session } = props;
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);
  const canPlayFiles = filePlaybackSupported();
  const canShare = screenShareSupported();

  const submit = (e: Event) => {
    e.preventDefault();
    const check = checkMovieUrl(url, location.protocol === 'https:');
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    session.setMovie({ url: check.url });
    setUrl('');
    setError(undefined);
    props.onClose();
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="Watch together"
      subtitle="Put something on for the whole room."
      width={540}
      testId="watch-dialog"
    >
      <div class="watch-options">
        <section class="watch-option">
          <FileVideo />
          <div class="grow">
            <h3>A video file on this device</h3>
            <p>
              An episode or film you have saved. It plays from your device and is streamed to the
              room — nothing is uploaded. <strong>Everyone can pause, play and skip.</strong>
            </p>
            {!canPlayFiles && <p class="hint">This browser cannot stream a file. Chrome, Edge, Brave and Firefox can.</p>}
            <input
              ref={fileInput}
              type="file"
              accept="video/*,.mkv,.mp4,.webm,.mov,.m4v"
              class="sr-only"
              tabIndex={-1}
              data-testid="file-input"
              onChange={(e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                (e.target as HTMLInputElement).value = '';
                if (!file) return;
                void session.chooseFile(file);
                props.onClose();
              }}
            />
            <Button variant="primary" disabled={!canPlayFiles} onClick={() => fileInput.current?.click()} data-testid="choose-file">
              Choose a file
            </Button>
          </div>
        </section>

        <section class="watch-option">
          <Link2 />
          <form class="grow" onSubmit={submit} novalidate>
            <h3>
              <label for="movie-url">A link to a video file</label>
            </h3>
            <p>
              A direct link to an MP4 or WebM. Each person’s browser loads it and BraveTalk keeps
              everyone at the same moment. <strong>Everyone can pause, play and skip.</strong>
            </p>
            <div class="invite-row">
              <input
                id="movie-url"
                class="input"
                type="url"
                inputMode="url"
                autocomplete="off"
                spellcheck={false}
                placeholder="https://example.com/film.mp4"
                value={url}
                aria-invalid={error ? 'true' : undefined}
                onInput={(e) => {
                  setUrl((e.target as HTMLInputElement).value);
                  setError(undefined);
                }}
              />
              <Button type="submit" data-testid="watch-start">
                Start
              </Button>
            </div>
            {error && (
              <span class="field-error" role="alert" data-testid="watch-error">
                {error}
              </span>
            )}
            <p class="hint">The site hosting the video will see each viewer’s IP address.</p>
          </form>
        </section>

        <section class="watch-option">
          <PanelTop />
          <div class="grow">
            <h3>Netflix, YouTube or any other site</h3>
            <p>
              Share the browser tab it is playing in, with sound. Those sites run their own player,
              so only the person sharing can press pause — everyone else gets an{' '}
              <strong>Ask to pause</strong> button that pings them.
            </p>
            {!canShare && <p class="hint">Phone and tablet browsers cannot share a tab.</p>}
            <Button
              disabled={!canShare}
              onClick={() => {
                props.onClose();
                props.onShareTab();
              }}
              data-testid="watch-share-tab"
            >
              Share a tab with sound
            </Button>
          </div>
        </section>
      </div>
    </Dialog>
  );
}

const SHORTCUTS: [string, string][] = [
  ['M', 'Mute or unmute your microphone'],
  ['D', 'Deafen or undeafen'],
  ['V', 'Turn your camera on or off'],
  ['S', 'Share your screen, or open share controls'],
  ['C', 'Open or close chat'],
  ['P', 'Open or close the people list'],
  ['F', 'Enter or leave fullscreen'],
  ['L', 'Cycle the viewing layout'],
  ['?', 'Show this list'],
  ['Esc', 'Close whatever is open'],
];

export function ShortcutsDialog(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title="Keyboard shortcuts" width={420} testId="shortcuts">
      <ul class="shortcuts">
        {SHORTCUTS.map(([key, what]) => (
          <li key={key}>
            <span>{what}</span>
            <kbd class="kbd">{key}</kbd>
          </li>
        ))}
      </ul>
      <p class="hint">Shortcuts are ignored while you are typing.</p>
    </Dialog>
  );
}
