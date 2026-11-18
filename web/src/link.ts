/**
 * The small window the bookmarklet opens. It relays between the video tab
 * (its opener, another site) and the Shh VC call tab (same origin, over a
 * BroadcastChannel). It sends nothing anywhere else.
 */
import '@fontsource-variable/geist';
import './styles/tokens.css';
import './styles/link.css';
import { LINK_CHANNEL, type BridgeStatus } from './movie/link-protocol.ts';

const headline = document.getElementById('headline')!;
const detail = document.getElementById('detail')!;
const go = document.getElementById('go') as HTMLButtonElement;
const player = window.opener as Window | null;
const ch = new BroadcastChannel(LINK_CHANNEL);
let site = '';
let lastRoom = 0;
let lastPlayer = 0;
let goWatch = '';

function show(title: string, text: string, state: string): void {
  headline.textContent = title;
  detail.textContent = text;
  document.body.dataset.state = state;
}

function render(s: BridgeStatus): void {
  go.hidden = s.kind !== 'go';
  if (s.kind === 'linked') show('In sync with your call', s.title ? `Watching ${s.title}` : 'Play, pause and skip on Netflix as usual.', 'ok');
  else if (s.kind === 'busy') show('Something else is on in your call', 'Stop it there, then click the bookmark again.', 'warn');
  else if (s.kind === 'wait') show('Waiting for the call', 'The host has to start watching first.', 'warn');
  else {
    goWatch = s.watch;
    show(`${s.who} is on another episode`, s.title ? `They are watching ${s.title}.` : 'Go to the same one to sync.', 'warn');
  }
}

window.addEventListener('message', (e) => {
  if (!player || e.source !== player) return;
  const d = e.data as { shh?: number } | null;
  if (!d || d.shh !== 1) return;
  if (!site) player.postMessage({ to: 'player', type: 'hello' }, e.origin);
  site = e.origin;
  lastPlayer = Date.now();
  ch.postMessage({ ...d, shh: undefined, from: 'player', site });
});

ch.onmessage = (e: MessageEvent) => {
  const d = e.data as { to?: string; status?: BridgeStatus } | null;
  if (!d) return;
  if (d.to === 'player' && player && site) player.postMessage(d, site);
  if (d.to === 'bridge' && d.status) {
    lastRoom = Date.now();
    render(d.status);
  }
};

go.addEventListener('click', () => {
  if (player && site && goWatch) player.postMessage({ to: 'player', type: 'go', watch: goWatch }, site);
  show('Opening the episode…', 'When it has loaded, click the Shh VC Sync bookmark again.', 'warn');
  go.hidden = true;
});

function check(): void {
  const now = Date.now();
  if (!player || player.closed) show('The video tab is closed', 'Open the video, then click the Shh VC Sync bookmark again.', 'bad');
  else if (now - lastRoom > 4000) show('Open your call first', 'Join your Shh VC call in this browser, then click the bookmark again.', 'bad');
  else if (now - lastPlayer > 4000) show('No video found', 'Start playing the video in the other tab.', 'warn');
}

if (!player) show('This site blocked the link', 'Use the shared clock in your call instead: everyone presses play together.', 'bad');
else {
  ch.postMessage({ from: 'bridge', type: 'hello' });
  setInterval(check, 1500);
  setTimeout(check, 1200);
}
