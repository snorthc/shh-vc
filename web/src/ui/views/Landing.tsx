import { useEffect, useState } from 'preact/hooks';
import { ArrowRight, Check, Eye, Film, Lock, Minus, Settings as SettingsIcon } from 'lucide-preact';
import { DIRECT, FROM_FILE } from '../../app/mode.ts';
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
      setError(FROM_FILE ? 'Paste the room code you were sent.' : 'Paste the invite link you were sent.');
      return;
    }
    if (!openInvite(link)) setError(FROM_FILE ? 'That does not look like a Shh VC room code.' : 'That does not look like a Shh VC invite link.');
  };

  return (
    <div class="landing view">
      <header class="landing-nav">
        <a class="wordmark" href="./" aria-label="Shh VC">
          <Mark />
          <span>Shh VC</span>
        </a>
        <IconButton label="Settings" tipPos="left" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon />
        </IconButton>
      </header>

      <main>
        <section class="hero">
          <div class="hero-copy">
            <p class="eyebrow">
              <span class="eyebrow-dot" />
              Free · No account · End-to-end encrypted
            </p>
            <h1>Talk, share your screen, and watch together.</h1>
            <p class="lede">
              {FROM_FILE
                ? 'Private rooms for up to six people. No account, no website, nothing to install. Start a room, send the code, and you are talking.'
                : 'Private rooms for up to six people. No account and nothing to install. Start a room, send the link, and you are talking.'}
            </p>

            <div class="hero-actions">
              <Button variant="primary" size="lg" onClick={startNewRoom} data-testid="start-room">
                Start a room
                <ArrowRight />
              </Button>
              <form class="join-form" onSubmit={submit} novalidate>
                <label class="sr-only" for="invite">
                  {FROM_FILE ? 'Room code' : 'Invite link'}
                </label>
                <input
                  id="invite"
                  class="input"
                  type="text"
                  inputMode="url"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  placeholder={FROM_FILE ? 'Or paste a room code' : 'Or paste an invite link'}
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

        <section class="voice" aria-labelledby="voice-title">
          <div class="voice-copy">
            <p class="kicker">Your voice, not your room</p>
            <h2 id="voice-title">Keyboards, fans and traffic stay on your side.</h2>
            <p>
              Choose how much of the room to filter out. The strongest setting runs a neural
              network in your browser that strips background noise and leaves your voice natural.
              In our tests it cut a fan-and-keyboard background by 33 dB.
            </p>
            <p class="voice-small">
              It runs on your device. Your audio is never sent anywhere to be cleaned.
            </p>
          </div>
          <div class="voice-demo" aria-hidden="true">
            <div class="voice-modes">
              <span>Off</span>
              <span>Standard</span>
              <span>AI · Light</span>
              <span>AI · Strong</span>
            </div>
            <svg class="voice-wave" viewBox="0 0 600 160" preserveAspectRatio="none">
              <defs>
                <linearGradient id="vw" x1="0" x2="1">
                  <stop offset="0" stop-color="var(--brass)" stop-opacity="0.2" />
                  <stop offset="0.5" stop-color="var(--brass)" />
                  <stop offset="1" stop-color="var(--brass)" stop-opacity="0.2" />
                </linearGradient>
              </defs>
              <g class="vw-noise">
                {Array.from({ length: 75 }, (_, i) => {
                  const h = 10 + ((i * 37) % 23);
                  return <rect key={i} x={i * 8} y={80 - h / 2} width="3" height={h} rx="1.5" />;
                })}
              </g>
              <g class="vw-voice">
                {Array.from({ length: 75 }, (_, i) => {
                  const t = i / 74;
                  const env = Math.max(0, Math.sin(t * Math.PI * 3.2)) * (0.55 + 0.45 * Math.sin(t * 19));
                  const h = 6 + Math.abs(env) * 120;
                  return <rect key={i} x={i * 8} y={80 - h / 2} width="3" height={h} rx="1.5" />;
                })}
              </g>
            </svg>
            <div class="voice-meter">
              <span>Background noise</span>
              <span class="voice-meter-bar">
                <i />
              </span>
            </div>
          </div>
        </section>

        <section class="voice sync-section" aria-labelledby="sync-title">
          <div class="sync-demo" aria-hidden="true">
            <div class="sd-device sd-laptop">
              <span class="sd-clock">42:17</span>
              <span class="sd-tag">Netflix tab · in sync</span>
            </div>
            <div class="sd-device sd-tv">
              <span class="sd-clock">42:17</span>
            </div>
            <div class="sd-device sd-phone">
              <span class="sd-clock">42:17</span>
            </div>
          </div>
          <div class="voice-copy">
            <p class="kicker">Netflix night, from anywhere</p>
            <h2 id="sync-title">Everyone on their own Netflix, all at the same second.</h2>
            <p>
              Each person plays it on their own account — a laptop, a phone, the TV. Shh VC keeps a
              shared clock and counts everyone in, so you all press play together.
            </p>
            <p>
              On a computer, one bookmark links your Netflix tab to the call: pause, play and skip
              there, and everyone’s Netflix follows. The host decides who gets the remote.
            </p>
            <p class="voice-small">
              Shh VC never sends the film itself, only play, pause and the time. Everyone needs their
              own way to watch.
            </p>
          </div>
        </section>

        <section class="steps" aria-label="How it works">
          <ol>
            <li>
              <span class="step-n">1</span>
              <div>
                <h3>Start a room</h3>
                <p>One click. No sign-up, no download.</p>
              </div>
            </li>
            <li>
              <span class="step-n">2</span>
              <div>
                <h3>Send the link</h3>
                <p>Anyone who opens it can join, on a computer or a phone.</p>
              </div>
            </li>
            <li>
              <span class="step-n">3</span>
              <div>
                <h3>Talk, share, watch</h3>
                <p>Up to six people, encrypted the whole way.</p>
              </div>
            </li>
          </ol>
        </section>

        <section class="points" aria-label="What Shh VC does">
          <article>
            <Eye />
            <h2>See it before they do</h2>
            <p>
              Pick a screen, window or tab and Shh VC shows you exactly what will be shared. Nothing
              leaves your device until you press Start sharing.
            </p>
          </article>
          <article>
            <Lock />
            <h2>Encrypted end to end</h2>
            <p>
              {DIRECT
                ? 'Calls, shares and chat go straight from browser to browser, encrypted the whole way. There is no server in the middle to read them.'
                : 'Voice, video, screen shares and chat are encrypted in your browser with keys the server never holds. It relays bytes it cannot read.'}
            </p>
          </article>
          <article>
            <Film />
            <h2>Built for watching together</h2>
            <p>
              Netflix on everyone’s own account, a film from your device, or a link. Everyone gets
              the pause button unless the host keeps the remote.
            </p>
          </article>
        </section>

        <section class="honesty" aria-labelledby="honesty-title">
          <h2 id="honesty-title">What it hides, and what it does not</h2>
          {DIRECT ? (
            <div class="honesty-cols">
              <ul>
                <li>
                  <Check class="yes" />
                  Nobody in between can read your calls, shares or messages.
                </li>
                <li>
                  <Check class="yes" />
                  There is no server holding your room. Browsers connect to each other.
                </li>
                <li>
                  <Check class="yes" />
                  No account, no email, and nothing kept when the room ends.
                </li>
              </ul>
              <ul>
                <li>
                  <Minus class="no" />
                  People in the same room can see each other’s IP address, because your browsers
                  connect directly. Use a VPN if that matters to you.
                </li>
                <li>
                  <Minus class="no" />
                  The public relays that introduce browsers to each other see your IP address too,
                  but not what is said or shared.
                </li>
                <li>
                  <Minus class="no" />
                  Anyone with the link can join. Treat it like a password.
                </li>
              </ul>
            </div>
          ) : (
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
          )}
        </section>
      </main>

      <section class="cta">
        <h2>Ready when you are.</h2>
        <p>It takes a second to start, and nothing to install.</p>
        <Button variant="primary" size="lg" onClick={startNewRoom}>
          Start a room
          <ArrowRight />
        </Button>
      </section>

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
        <div class="sat sat-tile">
          <span class="sat-avatar">MT</span>
          <span class="sat-name">Mei</span>
          <span class="sat-bars">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
        <div class="sat sat-ns">
          <span class="sat-ns-label">AI noise filter</span>
          <svg viewBox="0 0 120 28" class="sat-wave">
            <path class="wave-noisy" d="M0 14 L4 9 L7 19 L10 6 L13 21 L16 10 L19 17 L22 5 L25 22 L28 11 L31 16 L34 7 L37 20 L40 12 L43 15 L46 4 L49 23 L52 10 L55 18 L58 6 L61 21 L64 9 L67 17 L70 5 L73 22 L76 12 L79 15 L82 7 L85 20 L88 11 L91 17 L94 6 L97 21 L100 10 L103 16 L106 8 L109 19 L112 12 L116 15 L120 14" />
            <path class="wave-clean" d="M0 14 L20 14 C24 14 26 6 30 6 C34 6 35 22 39 22 C43 22 44 8 48 8 C51 8 52 18 55 18 C58 18 59 14 62 14 L74 14 C77 14 78 9 81 9 C84 9 85 19 88 19 C91 19 92 14 95 14 L120 14" />
          </svg>
        </div>
        <svg class="figure-cursor" viewBox="0 0 24 24" width="22" height="22">
          <path d="M5 3l14 8-6.2 1.6L10.5 19z" fill="var(--bone)" stroke="var(--bg)" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </div>
    </div>
  );
}
