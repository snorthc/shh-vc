/**
 * The "Shh VC Sync" bookmarklet. It runs inside the person's own Netflix tab
 * (or any page with a video), opens the small Shh VC link window, reports
 * play, pause and position to it, and carries out what the room decides.
 *
 * It never touches the video's picture or sound and never reads anything but
 * playback state, the episode id and its title. On Netflix it uses Netflix's
 * own player controls, because skipping the video element directly breaks
 * Netflix's player.
 *
 * playerScript is serialised with toString(), so it must not use anything
 * from outside its own body.
 */
export function playerScript(linkUrl: string): void {
  type NfPlayer = {
    play(): void;
    pause(): void;
    seek(ms: number): void;
    getCurrentTime(): number;
    isPaused(): boolean;
  };
  const w = window as unknown as Window & {
    __shhvc?: { stop(): void };
    netflix?: { appContext?: { state?: { playerApp?: { getAPI?(): { videoPlayer: {
      getAllPlayerSessionIds(): string[];
      getVideoPlayerBySessionId(id: string): NfPlayer | undefined;
    } } } } } };
  };
  w.__shhvc?.stop();
  const origin = new URL(linkUrl).origin;
  const pop = window.open(linkUrl, 'shhvc-link', 'popup,width=400,height=340');

  const note = (text: string, ms = 6000) => {
    const el = document.createElement('div');
    el.textContent = text;
    el.setAttribute('role', 'status');
    el.style.cssText =
      'position:fixed;z-index:2147483647;left:16px;bottom:16px;max-width:360px;padding:12px 16px;border-radius:12px;' +
      'background:#111110;color:#efebe4;font:500 14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    document.body.append(el);
    setTimeout(() => el.remove(), ms);
  };
  if (!pop) {
    note('Shh VC: your browser blocked the pop-up. Allow pop-ups for this site, then click the bookmark again.', 9000);
    return;
  }

  const nf = (): NfPlayer | undefined => {
    try {
      const vp = w.netflix?.appContext?.state?.playerApp?.getAPI?.().videoPlayer;
      if (!vp) return undefined;
      const ids = vp.getAllPlayerSessionIds();
      const id = ids.find((i) => i.includes('watch')) ?? ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : undefined;
    } catch {
      return undefined;
    }
  };
  const video = (): HTMLVideoElement | undefined => {
    let best: HTMLVideoElement | undefined;
    for (const v of Array.from(document.querySelectorAll('video'))) {
      if (!best || v.videoWidth * v.videoHeight > best.videoWidth * best.videoHeight) best = v;
    }
    return best;
  };
  const read = () => {
    const p = nf();
    const v = video();
    if (!p && !v) return undefined;
    const nfTitle = document.querySelector('[data-uia="video-title"]') as HTMLElement | null;
    const watch = /\/watch\/(\d+)/.exec(location.pathname)?.[1];
    return {
      playing: p ? !p.isPaused() : !v!.paused,
      position: p ? p.getCurrentTime() / 1000 : v!.currentTime,
      title: (nfTitle?.innerText || document.title).replace(/\s+/g, ' ').trim().slice(0, 120),
      ...(watch ? { watch } : {}),
    };
  };
  const send = (type: 'tick' | 'event') => {
    const state = read();
    if (state && !pop.closed) pop.postMessage({ shh: 1, type, ...state }, origin);
  };

  let bound: HTMLVideoElement | undefined;
  // Events that just carry out the room's last command are ours, not the person's.
  let cmd = { playing: false, position: 0, at: 0 };
  const onEvent = () => {
    const s = read();
    const ours = s && Date.now() - cmd.at < 3000 && s.playing === cmd.playing && Math.abs(s.position - cmd.position) < 2;
    if (!ours) send('event');
  };
  const bind = () => {
    const v = video();
    if (v === bound) return;
    for (const e of ['play', 'pause', 'seeked']) {
      bound?.removeEventListener(e, onEvent);
      v?.addEventListener(e, onEvent);
    }
    bound = v;
  };

  const onMessage = (e: MessageEvent) => {
    if (e.source !== pop || e.origin !== origin) return;
    heard = true;
    const d = e.data as { to?: string; type?: string; playing?: unknown; position?: unknown; watch?: unknown };
    if (!d || d.to !== 'player') return;
    if (d.type === 'go' && typeof d.watch === 'string' && /^\d{1,12}$/.test(d.watch)) {
      location.href = `${location.origin}/watch/${d.watch}`;
      return;
    }
    if (d.type !== 'apply' || typeof d.playing !== 'boolean' || typeof d.position !== 'number') return;
    const p = nf();
    const v = video();
    cmd = { playing: d.playing, position: d.position, at: Date.now() };
    const now = p ? p.getCurrentTime() / 1000 : v?.currentTime ?? 0;
    if (Math.abs(now - d.position) > 1) {
      if (p) p.seek(Math.round(d.position * 1000));
      else if (v) v.currentTime = d.position;
    }
    if (d.playing) {
      if (p) p.play();
      else void v?.play().catch(() => note('Shh VC: click the video once so it may play.'));
    } else if (p) p.pause();
    else v?.pause();
  };

  // Some sites cut a page off from windows it opens; then the link window closes for us at once.
  let heard = false;
  window.addEventListener('message', onMessage);
  const tick = setInterval(() => {
    if (pop.closed) {
      stop();
      note(
        heard
          ? 'Shh VC: sync stopped. Click the bookmark again to link this tab.'
          : 'Shh VC: this site blocked the link to your call. Use the shared clock in your call instead.',
        9000,
      );
      return;
    }
    bind();
    send('tick');
  }, 1000);
  const stop = () => {
    clearInterval(tick);
    window.removeEventListener('message', onMessage);
    for (const e of ['play', 'pause', 'seeked']) bound?.removeEventListener(e, onEvent);
    w.__shhvc = undefined;
  };
  w.__shhvc = { stop };
  bind();
  setTimeout(() => {
    if (heard) note(video() ? 'Shh VC: linked to your call.' : 'Shh VC: linked. Start the video and it will sync.', 4000);
  }, 1500);
}

/** The javascript: link people drag to their bookmarks bar. */
export function bookmarkletHref(linkUrl: string): string {
  return `javascript:${encodeURIComponent(`(${playerScript.toString()})(${JSON.stringify(linkUrl)})`)}`;
}
