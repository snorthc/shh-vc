import { useEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, Copy, Headphones, Lock, Mic, MicOff, Settings as SettingsIcon, Video, VideoOff } from 'lucide-preact';
import { DIRECT, FROM_FILE } from '../../app/mode.ts';
import { settings, updateSettings } from '../../app/settings.ts';
import { backToStart, inviteLink, join, joinError, pending, preloadRoom, view } from '../../app/state.ts';
import { MicPipeline } from '../../audio/mic.ts';
import { mediaErrorText } from '../../call/errors.ts';
import { Avatar, Button, IconButton, Mark } from '../components/primitives.tsx';
import { SuppressionPicker } from '../components/SuppressionPicker.tsx';
import { SettingsDialog } from '../room/SettingsDialog.tsx';

/**
 * Device check before joining. The camera and microphone here are local
 * previews: nothing is sent anywhere until Join is pressed.
 */
export function PreJoin() {
  const room = pending.value!;
  const s = settings.value;
  const joining = view.value === 'joining';
  const [mic, setMic] = useState(!s.joinMuted);
  const [cam, setCam] = useState(!s.joinCameraOff);
  const [micError, setMicError] = useState<string | undefined>();
  const [camError, setCamError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nameError, setNameError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [hasVideo, setHasVideo] = useState(false);

  // Fetch the call engine while the person is checking their camera.
  useEffect(preloadRoom, []);

  // Camera preview
  useEffect(() => {
    if (!cam) {
      setHasVideo(false);
      return;
    }
    let stream: MediaStream | undefined;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { ...(s.camId ? { deviceId: s.camId } : {}), width: 1280, height: 720 } })
      .then((st) => {
        if (cancelled) {
          for (const t of st.getTracks()) t.stop();
          return;
        }
        stream = st;
        setCamError(undefined);
        if (videoRef.current) videoRef.current.srcObject = st;
        setHasVideo(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setCam(false);
        setCamError(mediaErrorText(err, 'camera'));
      });
    return () => {
      cancelled = true;
      if (stream) for (const t of stream.getTracks()) t.stop();
    };
  }, [cam, s.camId]);

  // Microphone preview, through the same pipeline the call uses, so the
  // suppression choice here is exactly what people will hear.
  const pipeRef = useRef<MicPipeline | undefined>(undefined);
  const [monitor, setMonitor] = useState(false);
  const [micNote, setMicNote] = useState<string | undefined>();
  useEffect(() => {
    // Hand the microphone over to the call as soon as joining starts.
    if (!mic || joining) return;
    const pipe = new MicPipeline(settings.peek().suppression, {
      deviceId: s.micId || undefined,
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGain,
    });
    pipeRef.current = pipe;
    let raf = 0;
    let cancelled = false;
    let smooth = 0;
    pipe
      .start()
      .then(() => {
        if (cancelled) return;
        setMicError(undefined);
        setMicNote(pipe.fallbackReason);
        pipe.setMonitor(monitor);
        const loop = () => {
          smooth = Math.max(pipe.level(), smooth * 0.88);
          const shown = Math.min(1, smooth);
          if (meterRef.current) meterRef.current.style.transform = `scaleX(${shown.toFixed(3)})`;
          frameRef.current?.style.setProperty('--level', shown.toFixed(3));
          raf = requestAnimationFrame(loop);
        };
        loop();
      })
      .catch((err) => {
        if (cancelled) return;
        setMic(false);
        setMicError(mediaErrorText(err, 'microphone'));
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      pipe.stop();
      if (pipeRef.current === pipe) pipeRef.current = undefined;
    };
  }, [mic, joining, s.micId, s.echoCancellation, s.autoGain]);

  useEffect(() => {
    const pipe = pipeRef.current;
    if (!pipe) return;
    void pipe.setMode(s.suppression).then(() => setMicNote(pipe.fallbackReason));
  }, [s.suppression]);

  useEffect(() => {
    pipeRef.current?.setMonitor(monitor);
  }, [monitor]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(room.secret));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (!s.name.trim()) {
      setNameError(true);
      document.getElementById('name')?.focus();
      return;
    }
    updateSettings({ joinMuted: !mic, joinCameraOff: !cam });
    void join({ mic, camera: cam });
  };

  const isHost = !!room.hostKey;

  return (
    <div class="prejoin view">
      <header class="prejoin-nav">
        <IconButton label="Back" tipPos="below" onClick={backToStart} disabled={joining}>
          <ArrowLeft />
        </IconButton>
        <span class="wordmark">
          <Mark />
          <span>Shh VC</span>
        </span>
        <IconButton label="Settings" tipPos="left" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon />
        </IconButton>
      </header>

      <div class="prejoin-body">
        <div class="preview">
          <div ref={frameRef} class={`preview-frame ${s.mirrorSelf ? 'mirror' : ''} ${mic ? 'listening' : ''}`}>
            <video ref={videoRef} autoPlay playsInline muted style={{ opacity: hasVideo && cam ? 1 : 0 }} />
            {!(hasVideo && cam) && (
              <div class="preview-empty">
                <Avatar name={s.name || 'Guest'} hue={s.hue} size={84} />
                <span>{camError ? 'Camera unavailable' : 'Camera is off'}</span>
              </div>
            )}
            <div class="preview-controls">
              <button
                type="button"
                class={`dock-btn ${mic ? '' : 'off'}`}
                aria-pressed={mic}
                aria-label={mic ? 'Turn microphone off' : 'Turn microphone on'}
                data-tip={mic ? 'Microphone on' : 'Microphone off'}
                onClick={() => setMic(!mic)}
              >
                {mic ? <Mic /> : <MicOff />}
              </button>
              <button
                type="button"
                class={`dock-btn ${cam ? '' : 'off'}`}
                aria-pressed={cam}
                aria-label={cam ? 'Turn camera off' : 'Turn camera on'}
                data-tip={cam ? 'Camera on' : 'Camera off'}
                onClick={() => setCam(!cam)}
              >
                {cam ? <Video /> : <VideoOff />}
              </button>
            </div>
          </div>
          <div class="meter-row" aria-hidden={!mic}>
            <Mic />
            <div class="meter">
              <span ref={meterRef} style={{ transform: 'scaleX(0)' }} />
            </div>
            <span class="meter-label">{mic ? 'Say something — the bar shows what others will hear' : 'Microphone is off'}</span>
            <button
              type="button"
              class={`hear-btn ${monitor ? 'on' : ''}`}
              aria-pressed={monitor}
              disabled={!mic}
              onClick={() => setMonitor(!monitor)}
              data-tip="Hear yourself through the filter. Use headphones."
              data-testid="hear-yourself"
            >
              <Headphones />
              <span>{monitor ? 'Listening' : 'Hear yourself'}</span>
            </button>
          </div>
          <div class="prejoin-suppression">
            <span class="label">Noise suppression</span>
            <SuppressionPicker compact value={s.suppression} note={micNote} onChange={(v) => updateSettings({ suppression: v })} />
          </div>
          {(micError || camError) && (
            <p class="field-error" role="alert">
              {micError ?? camError}
            </p>
          )}
        </div>

        <form class="prejoin-form" onSubmit={submit} novalidate>
          <h1>{room.created ? 'Your room is ready' : 'Ready to join?'}</h1>
          <p class="lede">
            {room.created
              ? isHost
                ? 'Send the link to the people you want here. You are the host: you can lock the room and remove people.'
                : FROM_FILE
                  ? 'Send this room code to the people you want here, along with the Shh VC file. They open the file and paste the code.'
                  : 'Send the link to the people you want here, then come in.'
              : 'Check how you look and sound, then come in.'}
          </p>

          <div class="field">
            <label class="label" for="name">
              Your name
            </label>
            <input
              id="name"
              class="input"
              type="text"
              maxLength={48}
              autocomplete="nickname"
              autocapitalize="words"
              spellcheck={false}
              placeholder="What should people call you?"
              value={s.name}
              aria-invalid={nameError ? 'true' : undefined}
              data-autofocus
              onInput={(e) => {
                updateSettings({ name: (e.target as HTMLInputElement).value });
                setNameError(false);
              }}
            />
            {nameError && <span class="field-error">Enter a name so people know who you are.</span>}
          </div>

          {room.created && (
            <div class="field">
              <span class="label">{FROM_FILE ? 'Room code' : 'Invite link'}</span>
              <div class="invite-row">
                <input class="input mono" type="text" readOnly value={inviteLink(room.secret)} aria-label={FROM_FILE ? 'Room code' : 'Invite link'} onFocus={(e) => (e.target as HTMLInputElement).select()} />
                <Button onClick={copy} aria-live="polite">
                  {copied ? <Check /> : <Copy />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <span class="hint">{FROM_FILE ? 'The code is the key to the room. Send it somewhere private.' : 'The link is the key to the room. Send it somewhere private.'}</span>
            </div>
          )}

          {joinError.value && (
            <p class="field-error" role="alert" data-testid="join-error">
              {joinError.value}
            </p>
          )}

          <Button type="submit" variant="primary" size="lg" block loading={joining} data-testid="join">
            {joining ? 'Joining' : room.created ? 'Enter room' : 'Join room'}
          </Button>

          <p class="secure-line">
            <Lock />
            {DIRECT
              ? 'End-to-end encrypted, browser to browser. People in the room can see each other’s IP address.'
              : 'End-to-end encrypted. The server relays media it cannot read.'}
          </p>
        </form>
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
