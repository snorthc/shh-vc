/**
 * Entry point.
 *
 * The room secret is read from location.hash and never leaves memory except
 * as a hash (for the server) and as derived keys (inside the encrypted
 * channel). Do not add analytics, error reporting, or anything else that could
 * serialise the URL.
 */
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/views.css';
import './styles/room.css';
import './styles/chat.css';
import { render } from 'preact';
import { boot, pending, RoomScreen, session, view } from './app/state.ts';
import { Toasts } from './ui/components/Toasts.tsx';
import { Ended, Unsupported } from './ui/views/Ended.tsx';
import { Landing } from './ui/views/Landing.tsx';
import { PreJoin } from './ui/views/PreJoin.tsx';

function App() {
  const v = view.value;
  const s = session.value;
  const Room = RoomScreen.value;
  return (
    <>
      {v === 'landing' && <Landing />}
      {(v === 'prejoin' || v === 'joining') && pending.value && <PreJoin />}
      {v === 'room' && s && Room && <Room key={s.identity} session={s} />}
      {v === 'ended' && <Ended />}
      {v === 'unsupported' && <Unsupported />}
      <Toasts />
    </>
  );
}

boot();
render(<App />, document.getElementById('app')!);
