import { useRef, useState } from 'preact/hooks';
import { Clapperboard, FileVideo, Link2, PanelTop } from 'lucide-preact';
import type { RoomSession } from '../../call/session.ts';
import { checkMovieUrl } from '../../movie/sync.ts';
import { filePlaybackSupported, screenShareSupported } from '../../share/support.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Button } from '../components/primitives.tsx';
import { SyncSetup } from './OwnPlayer.tsx';

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
  const [title, setTitle] = useState('');
  const [setup, setSetup] = useState(false);
  const canStart = session.allowed('other');
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
          <Clapperboard />
          <form
            class="grow"
            novalidate
            onSubmit={(e) => {
              e.preventDefault();
              if (session.setMovie({ url: 'own', kind: 'own', title: title.trim().slice(0, 120) })) {
                setTitle('');
                props.onClose();
              }
            }}
          >
            <h3>
              <label for="own-title">On everyone’s own Netflix, or any service</label>
            </h3>
            <p>
              Everyone plays it on their own account and device — a laptop, phone or TV. Shh VC
              keeps a shared clock with a count-in, so you all press play together.{' '}
              <strong>On a computer, a bookmark syncs your Netflix tab automatically.</strong>
            </p>
            <div class="invite-row">
              <input
                id="own-title"
                class="input"
                type="text"
                autocomplete="off"
                maxLength={120}
                placeholder="What are you watching? (optional)"
                value={title}
                onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                data-testid="own-title-input"
              />
              <Button type="submit" variant="primary" disabled={!canStart} data-testid="own-start">
                Start
              </Button>
            </div>
            {!canStart && <p class="hint">The host has the say over what you watch.</p>}
            <button type="button" class="link-btn" aria-expanded={setup} onClick={() => setSetup(!setup)}>
              {setup ? 'Hide' : 'Set up automatic Netflix sync'}
            </button>
            {setup && <SyncSetup />}
          </form>
        </section>

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
              A direct link to an MP4 or WebM. Each person’s browser loads it and Shh VC keeps
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
            <h3>Share a tab with sound</h3>
            <p>
              Everyone sees what is playing in one of your tabs, so only you need an account. Only
              you can press pause — everyone else gets <strong>Ask to pause</strong>. Netflix and
              other protected services show black when shared; use the first option for those.
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
