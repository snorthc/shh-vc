import { useEffect, useState } from 'preact/hooks';
import { ArrowRight, Check, Eye, Film, Lock, Minus, Settings as SettingsIcon } from 'lucide-preact';
import { openInvite, startNewRoom } from '../../app/state.ts';
import { Button, IconButton, Mark } from '../components/primitives.tsx';
import { SettingsDialog } from '../room/SettingsDialog.tsx';

export function Landing() {
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The landing page is the one screen long enough to scroll.
  useEffect(() => {
    document.body.classList.add('scrollable');
    return () => document.body.classList.remove('scrollable');
  }, []);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!link.trim()) {
      setError('Paste the invite link you were sent.');
      return;
    }
    if (!openInvite(link)) setError('That does not look like a BraveTalk invite link.');
  };

  return (
    <div class="landing view">
      <header class="landing-nav">
        <a class="wordmark" href="./" aria-label="BraveTalk">
          <Mark />
          <span>BraveTalk</span>
        </a>
        <IconButton label="Settings" tipPos="left" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon />
        </IconButton>
      </header>

      <main>
        <section class="hero">
          <div class="hero-copy">
            <h1>Talk, share your screen, and watch together.</h1>
            <p class="lede">
              Private rooms for up to six people. No account and nothing to install. Start a room,
              send the link, and you are talking.
            </p>

            <div class="hero-actions">
              <Button variant="primary" size="lg" onClick={startNewRoom} data-testid="start-room">
                Start a room
                <ArrowRight />
              </Button>
              <form class="join-form" onSubmit={submit} novalidate>
                <label class="sr-only" for="invite">
                  Invite link
                </label>
                <input
                  id="invite"
                  class="input"
                  type="text"
                  inputMode="url"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  placeholder="Or paste an invite link"
                  value={link}
                  aria-invalid={error ? 'true' : undefined}
                  aria-describedby={error ? 'invite-error' : undefined}
                  onInput={(e) => {
                    setLink((e.target as HTMLInputElement).value);
                    setError(undefined);
                  }}
                />
                <Button type="submit" size="lg">
                  Join
                </Button>
              </form>
              {error && (
                <p class="field-error" id="invite-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </div>

          <SharePreviewFigure />
        </section>

        <section class="points" aria-label="What BraveTalk does">
          <article>
            <Eye />
            <h2>See it before they do</h2>
            <p>
              Pick a screen, window or tab and BraveTalk shows you exactly what will be shared. Nothing
              leaves your device until you press Start sharing.
            </p>
          </article>
          <article>
            <Lock />
            <h2>Encrypted end to end</h2>
            <p>
              Voice, video, screen shares and chat are encrypted in your browser with keys the server
              never holds. It relays bytes it cannot read.
            </p>
          </article>
          <article>
            <Film />
            <h2>Built for watching together</h2>
            <p>
              Put on a film from your device, a link, or a browser tab. Everyone gets the pause
              button, with chat and reactions alongside.
            </p>
          </article>
        </section>

        <section class="honesty" aria-labelledby="honesty-title">
          <h2 id="honesty-title">What it hides, and what it does not</h2>
          <div class="honesty-cols">
            <ul>
              <li>
                <Check class="yes" />
                Other people in the room never see your IP address.
              </li>
              <li>
                <Check class="yes" />
                The server cannot read your calls, shares or messages.
              </li>
              <li>
                <Check class="yes" />
                No account, no email, and nothing kept when the room ends.
              </li>
            </ul>
            <ul>
              <li>
                <Minus class="no" />
                The server does see your IP address, and who is in a room together and when. Use a
                VPN if that matters to you.
              </li>
              <li>
                <Minus class="no" />
                Anyone with the link can join. Treat it like a password, and lock the room once
                everyone is in.
              </li>
            </ul>
          </div>
        </section>
      </main>

      <footer class="landing-foot">
        <span>Free and open source. No tracking and no third-party scripts.</span>
      </footer>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

/**
 * A drawing of the pre-share preview, the feature the product is built
 * around. It is an illustration, not a live control, and is hidden from
 * assistive technology.
 */
function SharePreviewFigure() {
  return (
    <div class="figure-wrap" aria-hidden="true">
      <div class="figure-glow" />
      <div class="figure">
        <div class="figure-head">
          <span class="figure-chip">
            <span class="figure-dot" />
            <span class="chip-a">Only you can see this</span>
            <span class="chip-b">Live to the room</span>
          </span>
          <span class="figure-src">Browser tab · 1920 × 1080</span>
        </div>
        <div class="figure-screen">
          <div class="figure-bar">
            <i />
            <i />
            <i />
          </div>
          <div class="figure-lines">
            <b style={{ width: '46%' }} />
            <b style={{ width: '82%' }} />
            <b style={{ width: '71%' }} />
            <b style={{ width: '58%' }} />
            <b style={{ width: '77%' }} />
            <b style={{ width: '34%' }} />
          </div>
        </div>
        <div class="figure-foot">
          <span class="figure-viewers">
            <i style={{ '--h': 250 }} />
            <i style={{ '--h': 20 }} />
            <i style={{ '--h': 150 }} />
          </span>
          <span class="figure-btn ghost">Cancel</span>
          <span class="figure-btn go">Start sharing</span>
        </div>
        <svg class="figure-cursor" viewBox="0 0 24 24" width="22" height="22">
          <path d="M5 3l14 8-6.2 1.6L10.5 19z" fill="var(--bone)" stroke="var(--bg)" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </div>
    </div>
  );
}
