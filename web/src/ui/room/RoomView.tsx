import { useEffect, useRef, useState } from 'preact/hooks';
import {
  AudioLines, Check, ChevronUp, Clapperboard, Ellipsis, Headphones, HeadphoneOff, Keyboard, Link2, Lock, LockOpen, Maximize, MessageSquare, Mic, MicOff,
  Minimize, MonitorUp, PhoneOff, Settings as SettingsIcon, ShieldCheck, Smile, Users, Video, VideoOff, VolumeX, WifiOff, X,
} from 'lucide-preact';
import { FROM_FILE } from '../../app/mode.ts';
import { SUPPRESSION_OPTIONS } from '../../audio/mic.ts';
import { type LayoutMode, settings, updateSettings } from '../../app/settings.ts';
import { inviteLink, leaveRoom } from '../../app/state.ts';
import { formatDuration } from '../../app/util.ts';
import type { RoomSession } from '../../call/session.ts';
import { QUICK_REACTIONS } from '../../chat/store.ts';
import { useEvent, useIsMobile, usePresence, useSheetDrag, useTicker } from '../components/hooks.ts';
import { MenuItem, Popover } from '../components/Popover.tsx';
import { SuppressionPicker } from '../components/SuppressionPicker.tsx';
import { Button, IconButton, Mark, Segmented } from '../components/primitives.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { ShortcutsDialog, VerifyDialog, WatchDialog } from './Dialogs.tsx';
import { PeoplePanel } from './PeoplePanel.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { ShareDialog } from './ShareDialog.tsx';
import { Stage } from './Stage.tsx';

type Panel = 'chat' | 'people' | null;
type DialogId = 'settings' | 'verify' | 'watch' | 'shortcuts' | 'share' | null;

const LAYOUTS: { value: LayoutMode; label: string; sub: string }[] = [
  { value: 'presentation', label: 'Presentation', sub: 'Large content, people alongside' },
  { value: 'cinema', label: 'Cinema', sub: 'Content only, controls fade away' },
  { value: 'theatre', label: 'Theatre', sub: 'Content with people and chat' },
  { value: 'social', label: 'Social', sub: 'Content and people side by side' },
];

function DockButton(props: {
  label: string;
  tip: string;
  onClick: () => void;
  off?: boolean;
  live?: boolean;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  badge?: number;
  testId?: string;
  btnRef?: { current: HTMLButtonElement | null };
  children: preact.ComponentChildren;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      ref={props.btnRef}
      class={`dock-btn ${props.off ? 'off' : ''} ${props.live ? 'live' : ''} ${props.active ? 'active' : ''} ${props.danger ? 'danger' : ''}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      data-tip={props.tip}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props.testId}
    >
      {props.children}
      {!!props.badge && <span class="badge mono">{props.badge > 9 ? '9+' : props.badge}</span>}
    </button>
  );
}

export function RoomView(props: { session: RoomSession }) {
  const { session } = props;
  const mobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [dialog, setDialog] = useState<DialogId>(null);
  const [settingsTab, setSettingsTab] = useState<'profile' | 'devices' | 'share' | 'sounds'>('devices');
  const [menu, setMenu] = useState<'more' | 'react' | 'share' | 'mic' | null>(null);
  const [hasContent, setHasContent] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [copied, setCopied] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const micMenuRef = useRef<HTMLButtonElement>(null);
  const reactRef = useRef<HTMLButtonElement>(null);
  const shareRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelPresence = usePresence(panel !== null, 180);
  const lastPanel = useRef<Panel>('chat');
  if (panel) lastPanel.current = panel;
  const shownPanel = panel ?? lastPanel.current;
  const sheetDrag = useSheetDrag(panelRef, () => setPanel(null));

  const micOn = session.micOn.value;
  const camOn = session.camOn.value;
  const deafened = session.deafened.value;
  const share = session.share;
  const sharePhase = share.phase.value;
  const sharing = sharePhase === 'live';
  const status = session.status.value;
  const people = session.participants.value;
  const layout = settings.value.layout;
  const unread = session.unread.value;
  const started = session.startedAt.value;
  useTicker(1000, !!started);

  // The share dialog follows the share flow: picker open, previewing, or an error to show.
  const shareDialogOpen =
    dialog === 'share' && (sharePhase === 'choosing' || sharePhase === 'preview' || sharePhase === 'starting' || !!share.previewStream.value || !!share.error.value);

  // A thin level under the microphone button: proof you are being heard.
  const micLevel = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let smooth = 0;
    const t = setInterval(() => {
      // After suppression: this is what the room hears from you.
      smooth = Math.max(session.micLevel(), smooth * 0.7);
      if (micLevel.current) micLevel.current.style.transform = `scaleX(${smooth.toFixed(3)})`;
    }, 90);
    return () => clearInterval(t);
  }, []);

  const startShare = () => {
    setMenu(null);
    if (!share.supported) return;
    setDialog('share');
    void share.choose();
  };
  const onShareButton = () => {
    if (sharing) setMenu(menu === 'share' ? null : 'share');
    else startShare();
  };

  const togglePanel = (p: Exclude<Panel, null>) => {
    setMenu(null);
    setPanel(panel === p ? null : p);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.().catch(() => undefined);
  };
  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const setLayout = (value: LayoutMode) => {
    updateSettings({ layout: value });
    if (value === 'theatre' && !mobile) setPanel('chat');
    if (value === 'cinema') setPanel(null);
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(session.roomSecret));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setPanel('people');
    }
  };

  // Controls fade away while watching, and return the moment you move.
  const autoHide = (fullscreen || (layout === 'cinema' && hasContent)) && !panel && !dialog && !menu;
  useEffect(() => {
    if (!autoHide) {
      setIdle(false);
      return;
    }
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), 2800);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [autoHide]);

  useEvent('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (dialog) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    // Escape always works, even from the chat box; other shortcuts wait until you stop typing.
    if (typing && e.key !== 'Escape') return;
    switch (e.key.toLowerCase()) {
      case 'm':
        void session.setMic(!session.micOn.peek());
        break;
      case 'd':
        session.setDeafened(!session.deafened.peek());
        break;
      case 'v':
        void session.setCamera(!session.camOn.peek());
        break;
      case 's':
        onShareButton();
        break;
      case 'c':
        togglePanel('chat');
        break;
      case 'p':
        togglePanel('people');
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'l': {
        const i = LAYOUTS.findIndex((l) => l.value === layout);
        setLayout(LAYOUTS[(i + 1) % LAYOUTS.length]!.value);
        break;
      }
      case '?':
        setDialog('shortcuts');
        break;
      case 'escape':
        if (menu) setMenu(null);
        else if (panel) setPanel(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  const openSettings = (tab: typeof settingsTab) => {
    setMenu(null);
    setSettingsTab(tab);
    setDialog('settings');
  };

  const reactButtons = (
    <div class="react-row" role="group" aria-label="React">
      {QUICK_REACTIONS.map((e) => (
        <button type="button" key={e} class="emoji-cell" aria-label={`React ${e}`} onClick={() => { session.react(e); if (!mobile) setMenu(null); }} data-testid="stage-react">
          {e}
        </button>
      ))}
    </div>
  );

  return (
    <div
      ref={rootRef}
      class={`room view ${panel ? 'panel-open' : ''} ${idle ? 'chrome-hidden' : ''} ${fullscreen ? 'is-fullscreen' : ''}`}
      data-testid="room"
      data-status={status}
    >
      <header class="topbar">
        <div class="topbar-left">
          <Mark size={20} />
          <button type="button" class={`status-chip ${status}`} onClick={() => setDialog('verify')} data-testid="status" data-tip="Verify encryption" data-tip-pos="below">
            {status === 'connected' ? <Lock /> : <span class="spinner" />}
            <span>{status === 'connected' ? 'Encrypted' : status === 'reconnecting' ? 'Reconnecting' : 'Connecting'}</span>
          </button>
          {started && <span class="timer mono">{formatDuration((Date.now() - started) / 1000)}</span>}
          {session.locked.value && (
            <span class="lock-chip" data-testid="locked-chip">
              <Lock /> Locked
            </span>
          )}
        </div>
        <div class="topbar-right">
          {hasContent && !mobile && (
            <Segmented label="Viewing layout" value={layout} onChange={setLayout} options={LAYOUTS.map((l) => ({ value: l.value, label: l.label, title: l.sub }))} class="layout-switch" />
          )}
          <Button size="sm" onClick={copyInvite} data-testid="invite">
            {copied ? <Check /> : <Link2 />}
            <span class="hide-narrow">{copied ? (FROM_FILE ? 'Code copied' : 'Link copied') : 'Invite'}</span>
          </Button>
          {mobile && (
            <Button size="sm" variant="danger" onClick={() => void leaveRoom()} data-testid="leave">
              Leave
            </Button>
          )}
        </div>
      </header>

      <div class="room-body">
        <main class="stage-wrap">
          <Stage
            session={session}
            layout={layout}
            fullscreen={fullscreen}
            onFullscreen={toggleFullscreen}
            onChangeSource={startShare}
            onHasContent={setHasContent}
          />

          {deafened && (
            <button type="button" class="banner deaf" onClick={() => session.setDeafened(false)} data-testid="deafen-banner">
              <HeadphoneOff />
              <span>
                <strong>You are deafened.</strong> You cannot hear the room{micOn ? ', but people can still hear you' : ''}.
              </span>
              <span class="banner-action">Undeafen</span>
            </button>
          )}
          {session.audioBlocked.value && !deafened && (
            <button type="button" class="banner" onClick={() => void session.resumeAudio()}>
              <VolumeX />
              <span>
                <strong>Sound is paused by your browser.</strong> Click to hear the room.
              </span>
            </button>
          )}
          {!session.discoveryOnline.value && (
            <div class="banner warn" role="status" data-testid="discovery-offline">
              <WifiOff />
              <span>
                <strong>Nobody can find this room right now.</strong> The public relays that introduce
                browsers to each other are out of reach. People already here stay connected. Check
                your connection, or try another network or a VPN.
              </span>
            </div>
          )}
          {status === 'reconnecting' && (
            <div class="banner warn" role="status">
              <span class="spinner" />
              <span>
                <strong>Reconnecting.</strong> Your call will resume when the connection is back.
              </span>
            </div>
          )}

          <nav class="dock" aria-label="Call controls">
            <DockButton label={micOn ? 'Mute microphone' : 'Unmute microphone'} tip={micOn ? 'Mute · M' : 'Unmute · M'} off={!micOn} pressed={!micOn} onClick={() => void session.setMic(!micOn)} testId="mic">
              {micOn ? <Mic /> : <MicOff />}
              {micOn && <span class="mic-level" aria-hidden="true"><span ref={micLevel} /></span>}
            </DockButton>
            {!mobile && (
              <button
                type="button"
                ref={micMenuRef}
                class={`dock-caret ${menu === 'mic' ? 'active' : ''}`}
                aria-label="Microphone options"
                aria-expanded={menu === 'mic'}
                data-tip="Noise suppression"
                onClick={() => setMenu(menu === 'mic' ? null : 'mic')}
                data-testid="mic-options"
              >
                <ChevronUp />
              </button>
            )}
            <DockButton label={deafened ? 'Undeafen' : 'Deafen'} tip={deafened ? 'Undeafen · D' : 'Deafen · D'} off={deafened} pressed={deafened} onClick={() => session.setDeafened(!deafened)} testId="deafen">
              {deafened ? <HeadphoneOff /> : <Headphones />}
            </DockButton>
            <DockButton label={camOn ? 'Turn camera off' : 'Turn camera on'} tip={camOn ? 'Camera off · V' : 'Camera on · V'} active={camOn} pressed={camOn} onClick={() => void session.setCamera(!camOn)} testId="camera">
              {camOn ? <Video /> : <VideoOff />}
            </DockButton>
            {!mobile && (
              <DockButton
                label={sharing ? 'Screen share controls' : 'Share screen'}
                tip={!share.supported ? 'This browser cannot share a screen' : sharing ? 'Sharing · S' : 'Share screen · S'}
                live={sharing}
                disabled={!share.supported}
                onClick={onShareButton}
                btnRef={shareRef}
                testId="share"
              >
                <MonitorUp />
              </DockButton>
            )}
            {!mobile && (
              <DockButton label="React" tip="React" onClick={() => setMenu(menu === 'react' ? null : 'react')} btnRef={reactRef} testId="react">
                <Smile />
              </DockButton>
            )}
            <span class="dock-sep" aria-hidden="true" />
            <DockButton label={unread ? `Chat, ${unread} unread` : 'Chat'} tip="Chat · C" active={panel === 'chat'} pressed={panel === 'chat'} badge={panel === 'chat' ? 0 : unread} onClick={() => togglePanel('chat')} testId="chat-toggle">
              <MessageSquare />
            </DockButton>
            {!mobile && (
              <DockButton label={`People, ${people.length}`} tip="People · P" active={panel === 'people'} pressed={panel === 'people'} onClick={() => togglePanel('people')} testId="people-toggle">
                <Users />
              </DockButton>
            )}
            <DockButton label="More" tip="More" onClick={() => setMenu(menu === 'more' ? null : 'more')} btnRef={moreRef} testId="more">
              <Ellipsis />
            </DockButton>
            {!mobile && (
              <>
                <span class="dock-sep" aria-hidden="true" />
                <DockButton label="Leave room" tip="Leave" danger onClick={() => void leaveRoom()} testId="leave">
                  <PhoneOff />
                </DockButton>
              </>
            )}
          </nav>
        </main>

        {panelPresence.mounted && (
          <>
            {mobile && <div class={`panel-scrim ${panelPresence.closing ? 'closing' : ''}`} onClick={() => setPanel(null)} />}
            <aside ref={panelRef} class={`panel ${panelPresence.closing ? 'closing' : ''}`} aria-label={shownPanel === 'chat' ? 'Chat' : 'People'}>
              <div class="panel-head" {...(mobile ? sheetDrag : {})}>
                <span class="panel-grabber" aria-hidden="true" />
                <Segmented
                  label="Panel"
                  value={shownPanel ?? 'chat'}
                  onChange={(v) => setPanel(v)}
                  options={[
                    { value: 'chat', label: 'Chat' },
                    { value: 'people', label: `People · ${people.length}` },
                  ]}
                />
                <IconButton label="Close panel" tipPos="left" onClick={() => setPanel(null)} data-testid="panel-close">
                  <X />
                </IconButton>
              </div>
              {shownPanel === 'chat' ? <ChatPanel session={session} /> : <PeoplePanel session={session} />}
            </aside>
          </>
        )}
      </div>

      <Popover open={menu === 'mic'} onClose={() => setMenu(null)} anchor={micMenuRef} align="start" label="Microphone options" class="mic-pop" testId="mic-menu">
        <div class="menu-label">Noise suppression</div>
        <SuppressionPicker
          value={session.micSuppression.value}
          note={session.suppressionNote.value}
          onChange={(v) => void session.setSuppression(v)}
        />
        <div class="menu-sep" />
        <MenuItem icon={<SettingsIcon />} label="Microphone and devices" onSelect={() => openSettings('devices')} />
      </Popover>

      <Popover open={menu === 'react'} onClose={() => setMenu(null)} anchor={reactRef} label="React" class="react-pop">
        {reactButtons}
      </Popover>

      <Popover open={menu === 'share'} onClose={() => setMenu(null)} anchor={shareRef} label="Screen share">
        <div class="menu-label">You are sharing</div>
        <MenuItem icon={<MonitorUp />} label="Change source" sub="Preview a different screen, window or tab first." onSelect={startShare} />
        <MenuItem icon={<SettingsIcon />} label="Quality and audio" onSelect={() => openSettings('share')} />
        <div class="menu-sep" />
        <MenuItem icon={<X />} danger label="Stop sharing" onSelect={() => { setMenu(null); void share.stop(); }} />
      </Popover>

      <Popover open={menu === 'more'} onClose={() => setMenu(null)} anchor={moreRef} align={mobile ? 'end' : 'center'} label="More" testId="more-menu">
        {mobile && (
          <>
            {reactButtons}
            <div class="menu-sep" />
            <MenuItem
              icon={<MonitorUp />}
              label={sharing ? 'Stop sharing' : 'Share screen'}
              sub={share.supported ? undefined : 'Phone and tablet browsers cannot capture the screen. You can still watch what others share.'}
              disabled={!share.supported}
              onSelect={() => (sharing ? (setMenu(null), void share.stop()) : startShare())}
            />
            <MenuItem icon={<Users />} label={`People · ${people.length}`} onSelect={() => togglePanel('people')} />
            <MenuItem
              icon={<AudioLines />}
              label="Noise suppression"
              sub={SUPPRESSION_OPTIONS.find((o) => o.id === session.micSuppression.value)?.label}
              onSelect={() => openSettings('devices')}
            />
          </>
        )}
        <MenuItem icon={<Clapperboard />} label="Watch together" sub="Play a film or episode for the room. Everyone can pause." onSelect={() => { setMenu(null); setDialog('watch'); }} />
        {hasContent && (
          <>
            <div class="menu-sep" />
            <div class="menu-label">Layout</div>
            {LAYOUTS.map((l) => (
              <MenuItem
                key={l.value}
                label={l.label}
                sub={l.sub}
                trailing={layout === l.value ? <Check /> : undefined}
                onSelect={() => { setLayout(l.value); setMenu(null); }}
              />
            ))}
          </>
        )}
        <div class="menu-sep" />
        {document.fullscreenEnabled && (
          <MenuItem icon={fullscreen ? <Minimize /> : <Maximize />} label={fullscreen ? 'Leave fullscreen' : 'Fullscreen'} onSelect={() => { setMenu(null); toggleFullscreen(); }} />
        )}
        <MenuItem icon={<ShieldCheck />} label="Verify encryption" onSelect={() => { setMenu(null); setDialog('verify'); }} />
        {session.isHost.value && (
          <MenuItem
            icon={session.locked.value ? <LockOpen /> : <Lock />}
            label={session.locked.value ? 'Unlock room' : 'Lock room'}
            sub={session.locked.value ? undefined : 'Stop anyone new from joining.'}
            onSelect={() => { setMenu(null); void session.hostAction(session.locked.value ? 'unlock' : 'lock'); }}
          />
        )}
        {!mobile && <MenuItem icon={<Keyboard />} label="Keyboard shortcuts" onSelect={() => { setMenu(null); setDialog('shortcuts'); }} />}
        <MenuItem icon={<SettingsIcon />} label="Settings" onSelect={() => openSettings('devices')} />
      </Popover>

      <ShareDialog session={session} open={shareDialogOpen} onClose={() => setDialog(null)} />
      <SettingsDialog session={session} open={dialog === 'settings'} onClose={() => setDialog(null)} initialTab={settingsTab} />
      <VerifyDialog session={session} open={dialog === 'verify'} onClose={() => setDialog(null)} />
      <WatchDialog
        session={session}
        open={dialog === 'watch'}
        onClose={() => setDialog(null)}
        onShareTab={() => {
          // Tuned for video: smooth motion, and ask the browser for the tab's sound.
          updateSettings({ sharePreset: 'cinema', shareAudio: true });
          startShare();
        }}
      />
      <ShortcutsDialog open={dialog === 'shortcuts'} onClose={() => setDialog(null)} />
    </div>
  );
}
