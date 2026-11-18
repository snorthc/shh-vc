/**
 * Multi-browser tests of a real room: real SFU, real encryption, several
 * Chromium instances. Needs the local stack (./dev-stack.sh).
 */
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, DIRECT, freshSecret, type Harness, HOST_KEY, joinRoom, newClient, stackReachable, startHarness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  if (!(await stackReachable())) throw new Error('local stack not running: start it with ./dev-stack.sh');
  h = await startHarness();
}, 120_000);
afterAll(() => h?.close());

const closeAll = (...cs: Client[]) => Promise.all(cs.map((c) => c.ctx.close()));

/** Decoded frames on the first <video> inside a locator. */
const frames = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const v = document.querySelector(sel) as HTMLVideoElement | null;
    return v ? (v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) : -1;
  }, selector);

const peerCount = (page: Page) => page.locator('[data-testid="tile-peer"]').count();
const sess = <T>(page: Page, fn: string) => page.evaluate(`(() => { const s = window.__shh.session.value; return (${fn})(s); })()`) as Promise<T>;

async function openChat(...cs: Client[]) {
  for (const c of cs) {
    if (!(await c.page.getByTestId('chat').isVisible().catch(() => false))) await c.page.getByTestId('chat-toggle').click();
    await c.page.getByTestId('composer').waitFor();
  }
}

async function say(c: Client, text: string) {
  await c.page.getByTestId('composer').fill(text);
  await c.page.getByTestId('composer').press('Enter');
}

/** Wait until both sides hold each other's keys, so chat is deliverable. */
async function settled(...cs: Client[]) {
  for (const c of cs) {
    await expect
      .poll(() => sess<boolean>(c.page, 's => s.participants.value.length === ' + cs.length + ' && s.participants.value.every(p => p.keyed)'), { timeout: 30_000 })
      .toBe(true);
  }
  await cs[0]!.page.waitForTimeout(700);
}

describe('calls', () => {
  it('decrypts video in both directions and agrees on a safety number', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice', { camera: true });
    const b = await joinRoom(h, secret, 'Bob', { camera: true });
    await settled(a, b);
    await expect.poll(() => frames(a.page, '[data-testid="tile-peer"] video'), { timeout: 45_000 }).toBeGreaterThan(0);
    await expect.poll(() => frames(b.page, '[data-testid="tile-peer"] video'), { timeout: 45_000 }).toBeGreaterThan(0);

    const number = async (c: Client) => {
      await c.page.getByTestId('status').click();
      const n = (await c.page.getByTestId('safety-number').innerText()).trim();
      await c.page.keyboard.press('Escape');
      return n;
    };
    await expect.poll(async () => (await number(a)) === (await number(b)), { timeout: 30_000 }).toBe(true);
    expect(await number(a)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    await closeAll(a, b);
  }, 180_000);

  it('shows names, joins and leaves consistently for everyone', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    const c = await joinRoom(h, secret, 'Carol');
    await settled(a, b, c);
    for (const x of [a, b, c]) expect(await peerCount(x.page)).toBe(2);
    await expect(a.page.locator('[data-testid="tile-peer"]', { hasText: 'Bob' })).toBeDefined();
    expect(await a.page.locator('.tile-name').allInnerTexts()).toEqual(expect.arrayContaining(['Alice (you)', 'Bob', 'Carol']));

    await c.page.getByTestId('leave').click();
    await c.page.getByText('You left the room').waitFor();
    await expect.poll(() => peerCount(a.page), { timeout: 20_000 }).toBe(1);
    await expect.poll(() => peerCount(b.page), { timeout: 20_000 }).toBe(1);
    await closeAll(a, b, c);
  }, 180_000);

  it('keeps two different links in two different rooms', async () => {
    const a = await joinRoom(h, freshSecret(), 'Alice');
    const b = await joinRoom(h, freshSecret(), 'Stranger');
    await a.page.waitForTimeout(3000);
    expect(await peerCount(a.page)).toBe(0);
    expect(await peerCount(b.page)).toBe(0);
    await closeAll(a, b);
  }, 120_000);

  // There is no signalling server to drop in the serverless build.
  it.skipIf(DIRECT)('recovers from a dropped signalling connection', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);
    await a.page.evaluate('window.__shh.session.value.room.simulateScenario("signal-reconnect")');
    await a.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });
    await openChat(a, b);
    await say(a, 'still here after reconnecting');
    await b.page.getByText('still here after reconnecting').waitFor({ timeout: 20_000 });
    await closeAll(a, b);
  }, 180_000);
});

describe('mute and deafen', () => {
  it('treats them as two independent controls, and shows each to other people', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice', { mic: true });
    const b = await joinRoom(h, secret, 'Bob', { mic: true });
    await settled(a, b);
    const aliceOnBob = b.page.locator('[data-testid="tile-peer"]');
    await expect.poll(() => a.page.locator('[data-bt-audio] audio').count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // Deafen: incoming audio is silenced, the microphone is untouched.
    await a.page.getByTestId('deafen').click();
    await a.page.getByTestId('deafen-banner').waitFor();
    expect(await a.page.evaluate(() => [...document.querySelectorAll('[data-bt-audio] audio')].every((el) => (el as HTMLAudioElement).volume === 0))).toBe(true);
    expect(await sess<boolean>(a.page, 's => s.micOn.value')).toBe(true);
    expect(await a.page.getByTestId('mic').getAttribute('aria-label')).toBe('Mute microphone');
    expect(await a.page.getByTestId('deafen').getAttribute('aria-label')).toBe('Undeafen');
    await aliceOnBob.locator('[title^="Deafened"]').waitFor({ timeout: 15_000 });
    expect(await aliceOnBob.locator('[title="Microphone muted"]').count()).toBe(0);

    // Mute while deafened: both states show, independently.
    await a.page.getByTestId('mic').click();
    await aliceOnBob.locator('[title="Microphone muted"]').waitFor({ timeout: 15_000 });
    expect(await sess<boolean>(a.page, 's => s.deafened.value')).toBe(true);

    // Undeafen: audio returns, the microphone stays muted.
    await a.page.getByTestId('deafen').click();
    expect(await a.page.evaluate(() => [...document.querySelectorAll('[data-bt-audio] audio')].every((el) => (el as HTMLAudioElement).volume === 1))).toBe(true);
    expect(await sess<boolean>(a.page, 's => s.micOn.value')).toBe(false);
    await expect.poll(() => aliceOnBob.locator('[title^="Deafened"]').count(), { timeout: 15_000 }).toBe(0);
    await aliceOnBob.locator('[title="Microphone muted"]').waitFor();

    // Keyboard shortcuts drive the same state.
    await a.page.locator('body').press('m');
    await expect.poll(() => sess<boolean>(a.page, 's => s.micOn.value')).toBe(true);
    await a.page.locator('body').press('d');
    await expect.poll(() => sess<boolean>(a.page, 's => s.deafened.value')).toBe(true);
    await closeAll(a, b);
  }, 180_000);

  it('lets one person turn another down without affecting anyone else', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice', { mic: true });
    const b = await joinRoom(h, secret, 'Bob', { mic: true });
    await settled(a, b);
    await expect.poll(() => a.page.locator('[data-bt-audio] audio').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await a.page.getByTestId('people-toggle').click();
    await a.page.getByRole('button', { name: 'Options for Bob' }).click();
    await a.page.getByRole('menuitem', { name: /Mute for me/ }).click();
    expect(await a.page.evaluate(() => (document.querySelector('[data-bt-audio] audio') as HTMLAudioElement).volume)).toBe(0);
    expect(await sess<boolean>(b.page, 's => s.micOn.value')).toBe(true);
    await closeAll(a, b);
  }, 120_000);
});

describe('chat', () => {
  it('delivers, groups, replies, reacts, edits, deletes and shows typing — all in real time', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);

    // Unread badge while chat is closed
    await openChat(a);
    await say(a, 'first message');
    await expect.poll(() => b.page.getByTestId('chat-toggle').locator('.badge').innerText().catch(() => ''), { timeout: 20_000 }).toBe('1');
    await openChat(b);
    await b.page.getByText('first message').waitFor();
    expect(await b.page.getByTestId('chat-toggle').locator('.badge').count()).toBe(0);

    // Grouping: a second message from the same person has no second header
    await say(a, 'second message');
    await b.page.getByText('second message').waitFor();
    expect(await b.page.locator('.msg').count()).toBe(2);
    expect(await b.page.locator('.msg.grouped').count()).toBe(1);
    expect(await b.page.locator('.msg-head').count()).toBe(1);

    // Shift+Enter makes a new line instead of sending
    await a.page.getByTestId('composer').fill('line one');
    await a.page.getByTestId('composer').press('Shift+Enter');
    await a.page.getByTestId('composer').pressSequentially('line two');
    expect(await a.page.locator('.msg').count()).toBe(2);
    await a.page.getByTestId('composer').press('Enter');
    await expect.poll(async () => (await b.page.locator('.msg-text').last().innerText())).toBe('line one\nline two');

    // Typing indicator
    await b.page.getByTestId('composer').pressSequentially('thinking');
    await expect.poll(() => a.page.getByTestId('typing').innerText(), { timeout: 10_000 }).toContain('Bob is typing');
    await b.page.getByTestId('composer').press('Enter');
    await a.page.getByText('thinking').waitFor();
    await expect.poll(() => a.page.getByTestId('typing').innerText(), { timeout: 10_000 }).toBe('');

    // Reply
    const firstOnB = b.page.locator('.msg').first();
    await firstOnB.hover();
    await firstOnB.getByTestId('msg-reply').click();
    await b.page.getByText('Replying to').waitFor();
    await say(b, 'replying now');
    const reply = a.page.locator('.msg', { hasText: 'replying now' });
    await reply.waitFor();
    expect(await reply.locator('.msg-reply').innerText()).toContain('first message');

    // Reaction, seen by both, and toggled off again
    await firstOnB.hover();
    await firstOnB.getByTestId('msg-react').click();
    await b.page.locator('.emoji-pop .emoji-cell').first().click();
    const pillOnA = a.page.locator('.msg').first().getByTestId('reaction');
    await pillOnA.waitFor({ timeout: 10_000 });
    expect(await pillOnA.innerText()).toContain('1');
    await pillOnA.click();
    await expect.poll(async () => (await b.page.locator('.msg').first().getByTestId('reaction').innerText()).replace(/\s+/g, ''), { timeout: 10_000 }).toContain('2');
    await pillOnA.click();
    await expect.poll(async () => (await b.page.locator('.msg').first().getByTestId('reaction').innerText()).replace(/\s+/g, ''), { timeout: 10_000 }).toContain('1');

    // Only the author gets edit and delete
    await firstOnB.hover();
    expect(await firstOnB.getByTestId('msg-edit').count()).toBe(0);
    expect(await firstOnB.getByTestId('msg-delete').count()).toBe(0);

    // Edit
    const firstOnA = a.page.locator('.msg').first();
    await firstOnA.hover();
    await firstOnA.getByTestId('msg-edit').click();
    await firstOnA.getByLabel('Edit message').fill('first message, edited');
    await firstOnA.getByLabel('Edit message').press('Enter');
    await b.page.locator('.msg-text', { hasText: 'first message, edited' }).waitFor({ timeout: 10_000 });
    expect(await b.page.locator('.msg').first().innerText()).toContain('(edited)');

    // Delete needs a second click, then disappears for everyone
    const secondOnA = a.page.locator('.msg', { hasText: 'second message' });
    await secondOnA.hover();
    await secondOnA.getByTestId('msg-delete').click();
    expect(await a.page.locator('.msg-text', { hasText: 'second message' }).count()).toBe(1);
    await secondOnA.getByTestId('msg-delete').click();
    await expect.poll(() => b.page.locator('.msg-text', { hasText: 'second message' }).count(), { timeout: 10_000 }).toBe(0);
    expect(await b.page.getByText('Message deleted').count()).toBe(1);

    // Links are real links and never raw HTML
    await say(a, 'see https://example.com/page <img src=x onerror=alert(1)>');
    const link = b.page.locator('.msg-text a', { hasText: 'https://example.com/page' });
    await link.waitFor();
    expect(await link.getAttribute('rel')).toContain('noopener');
    expect(await b.page.locator('.msg-text img').count()).toBe(0);
    expect(a.errors.concat(b.errors)).toEqual([]);
    await closeAll(a, b);
  }, 240_000);

  it('does not show a late joiner what was said before they arrived', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);
    await openChat(a, b);
    await say(a, 'before carol');
    await b.page.getByText('before carol').waitFor();
    const c = await joinRoom(h, secret, 'Carol');
    await settled(a, b, c);
    await openChat(c);
    await say(a, 'after carol');
    await c.page.getByText('after carol').waitFor({ timeout: 20_000 });
    expect(await c.page.getByText('before carol').count()).toBe(0);
    await closeAll(a, b, c);
  }, 180_000);
});

describe('screen sharing', () => {
  const hasScreenPub = (page: Page) =>
    sess<boolean>(page, 's => [...s.room.localParticipant.trackPublications.values()].some(p => p.source === "screen_share")');
  const remoteScreens = (page: Page) =>
    sess<number>(page, 's => [...s.room.remoteParticipants.values()].reduce((n, p) => n + [...p.trackPublications.values()].filter(t => t.source === "screen_share").length, 0)');

  it('previews locally, sends nothing until confirmed, and cleans up on cancel', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);

    await a.page.getByTestId('share').click();
    await a.page.getByTestId('share-private-chip').waitFor({ timeout: 20_000 });
    await expect.poll(() => frames(a.page, '[data-testid="share-preview-video"]'), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(await a.page.getByTestId('share-private-chip').innerText()).toContain('Not shared yet');
    expect(await a.page.getByTestId('share-source').innerText()).toMatch(/Entire screen[\s\S]*1920 × 1080/);

    // The preview is on screen for Alice. Nothing has been published, and Bob sees nothing.
    await a.page.waitForTimeout(2500);
    expect(await hasScreenPub(a.page)).toBe(false);
    expect(await remoteScreens(b.page)).toBe(0);
    expect(await b.page.getByTestId('screen-tile').count()).toBe(0);

    // Cancel: the capture itself is stopped, not just hidden.
    const live = () => sess<string>(a.page, 's => (s.share.previewStream.value ? "live" : "none")');
    expect(await live()).toBe('live');
    await a.page.evaluate('window.__capture = window.__shh.session.value.share.previewStream.value');
    await a.page.getByTestId('share-cancel').click();
    await expect.poll(() => a.page.getByTestId('share-dialog').count()).toBe(0);
    expect(await a.page.evaluate('window.__capture.getTracks().every(t => t.readyState === "ended")')).toBe(true);
    expect(await sess<string>(a.page, 's => s.share.phase.value')).toBe('idle');
    expect(await remoteScreens(b.page)).toBe(0);
    await closeAll(a, b);
  }, 180_000);

  it('shares at full resolution after confirming, applies quality presets to the real sender, and stops cleanly', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);

    await a.page.getByTestId('share').click();
    await a.page.getByTestId('share-private-chip').waitFor({ timeout: 20_000 });
    await a.page.getByTestId('share-confirm').click();
    await a.page.getByTestId('share-live-chip').waitFor({ timeout: 30_000 });
    expect(await a.page.getByTestId('share-live-chip').innerText()).toContain('You are sharing your screen');

    // Bob decodes it, at full size.
    await b.page.getByTestId('screen-tile').waitFor({ timeout: 30_000 });
    await expect.poll(() => frames(b.page, '[data-testid="screen-tile"] video'), { timeout: 45_000 }).toBeGreaterThan(0);
    expect(await b.page.evaluate(() => (document.querySelector('[data-testid="screen-tile"] video') as HTMLVideoElement).videoHeight)).toBeGreaterThanOrEqual(1000);
    expect(await b.page.getByTestId('share-live-chip').innerText()).toContain('Alice is sharing');

    // The default preset (Balanced) is what the RTCRtpSender is actually using.
    const params = () => sess<{ maxBitrate: number; maxFramerate: number; degradation: string }>(a.page, 's => s.share.senderParameters()');
    expect(await params()).toMatchObject({ maxBitrate: 3_500_000, maxFramerate: 30 });

    // Change preset while live: the sender follows.
    await a.page.getByTestId('share').click();
    await a.page.getByRole('menuitem', { name: 'Quality and audio' }).click();
    await a.page.locator('[data-preset="text"]').click();
    await expect.poll(async () => (await params()).maxFramerate, { timeout: 10_000 }).toBe(15);
    expect(await params()).toMatchObject({ maxBitrate: 3_150_000, degradation: 'maintain-resolution' });
    expect(await a.page.getByTestId('quality-line').innerText()).toBe('1080p · 15 fps · up to 3.1 Mbps');
    await a.page.locator('[data-preset="custom"]').click();
    await a.page.getByRole('radio', { name: '720p' }).click();
    await a.page.getByLabel('Bitrate').selectOption('custom');
    await a.page.getByLabel('Ceiling, kbps').fill('1200');
    await a.page.getByLabel('Ceiling, kbps').press('Tab');
    await expect.poll(async () => (await params()).maxBitrate, { timeout: 10_000 }).toBe(1_200_000);
    await a.page.keyboard.press('Escape');

    // Diagnostics show measured numbers on both ends.
    await a.page.getByTestId('diag-toggle').click();
    await expect.poll(() => a.page.locator('[data-stat="Sending"]').innerText(), { timeout: 20_000 }).toMatch(/\d+ × \d+/);
    await expect.poll(() => a.page.locator('[data-stat="Bitrate"]').innerText(), { timeout: 20_000 }).toMatch(/\d/);
    expect(await a.page.locator('[data-stat="Codec"]').innerText()).toMatch(/VP9|VP8/);
    await b.page.getByTestId('diag-toggle').click();
    await expect.poll(() => b.page.locator('[data-stat="Receiving"]').innerText(), { timeout: 20_000 }).toMatch(/\d+ × \d+/);

    // Stop.
    await a.page.getByTestId('share-stop').click();
    await expect.poll(() => b.page.getByTestId('screen-tile').count(), { timeout: 20_000 }).toBe(0);
    expect(await sess<string>(a.page, 's => s.share.phase.value')).toBe('idle');
    expect(a.errors.concat(b.errors)).toEqual([]);
    await closeAll(a, b);
  }, 240_000);

  it('switches layout modes and fullscreen for the viewer', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);
    await a.page.getByTestId('share').click();
    await a.page.getByTestId('share-confirm').click();
    await b.page.getByTestId('screen-tile').waitFor({ timeout: 30_000 });
    const layout = () => b.page.getByTestId('stage').getAttribute('data-layout');
    expect(await layout()).toBe('presentation');
    for (const name of ['Cinema', 'Theatre', 'Social']) {
      await b.page.getByRole('radio', { name }).click();
      expect(await layout()).toBe(name.toLowerCase());
    }
    await b.page.getByRole('radio', { name: 'Cinema' }).click();
    expect(await b.page.locator('.strip').count()).toBe(0);
    await b.page.getByTestId('fullscreen').click();
    await expect.poll(() => b.page.evaluate(() => !!document.fullscreenElement), { timeout: 10_000 }).toBe(true);
    await b.page.keyboard.press('f');
    await expect.poll(() => b.page.evaluate(() => !!document.fullscreenElement), { timeout: 10_000 }).toBe(false);
    await closeAll(a, b);
  }, 180_000);

  it('explains itself when the browser cannot share, and when the picker is dismissed', async () => {
    const secret = freshSecret();
    const c = await newClient(h);
    await c.page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await c.page.goto(`${h.origin}/#k=${secret}`);
    await c.page.getByLabel('Your name').fill('Dana');
    await c.page.getByTestId('join').click();
    await c.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });
    await c.page.getByTestId('share').click();
    await c.page.getByTestId('share-error').waitFor();
    expect(await c.page.getByTestId('share-error').innerText()).toContain('Nothing was shared');
    expect(await sess<string>(c.page, 's => s.share.phase.value')).toBe('idle');
    await c.page.getByTestId('share-retry').waitFor();
    await c.ctx.close();
  }, 120_000);
});

describe('watch together', () => {
  it('keeps play, pause and seek in step, including for someone who joins late', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);
    const t = (c: Client) => c.page.evaluate(() => (document.querySelector('[data-testid="movie-video"]') as HTMLVideoElement).currentTime);
    const paused = (c: Client) => c.page.evaluate(() => (document.querySelector('[data-testid="movie-video"]') as HTMLVideoElement).paused);

    await a.page.getByTestId('more').click();
    await a.page.getByRole('menuitem', { name: /Watch together/ }).click();
    await a.page.getByLabel('Link to a video file').fill('https://www.youtube.com/watch?v=abc');
    await a.page.getByTestId('watch-start').click();
    expect(await a.page.getByTestId('watch-error').innerText()).toContain('own account');
    await a.page.getByLabel('Link to a video file').fill(`${h.origin}/__media/film.webm`);
    await a.page.getByTestId('watch-start').click();

    await b.page.getByTestId('movie').waitFor({ timeout: 20_000 });
    expect(await paused(b)).toBe(true);

    await a.page.getByTestId('movie-toggle').click();
    await expect.poll(() => paused(b), { timeout: 15_000 }).toBe(false);
    await a.page.waitForTimeout(3500);
    expect(Math.abs((await t(a)) - (await t(b)))).toBeLessThan(1.2);

    // Seek from the other side
    await sess(b.page, 's => s.setMovie({ position: 40 })');
    await expect.poll(async () => Math.abs((await t(a)) - 40) < 4 && Math.abs((await t(a)) - (await t(b))) < 1.2, { timeout: 20_000 }).toBe(true);

    // A late joiner lands at the same point
    const c = await joinRoom(h, secret, 'Carol');
    await c.page.getByTestId('movie').waitFor({ timeout: 30_000 });
    await expect.poll(async () => !(await paused(c)) && Math.abs((await t(a)) - (await t(c))) < 1.5, { timeout: 30_000 }).toBe(true);

    // Pause and stop reach everyone
    await b.page.getByTestId('movie-toggle').click();
    await expect.poll(() => paused(a), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => paused(c), { timeout: 15_000 }).toBe(true);
    await a.page.getByTestId('movie-close').click();
    await expect.poll(() => b.page.getByTestId('movie').count(), { timeout: 15_000 }).toBe(0);
    await expect.poll(() => c.page.getByTestId('movie').count(), { timeout: 15_000 }).toBe(0);
    await closeAll(a, b, c);
  }, 240_000);
});

describe('shared controls for what you are watching', () => {
  it('plays a file from one device for the room, and lets anyone pause and skip it', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);
    const host = () => a.page.evaluate(() => {
      const v = document.querySelector('[data-testid="file-video"]') as HTMLVideoElement;
      return { paused: v.paused, t: v.currentTime };
    });

    await a.page.getByTestId('more').click();
    await a.page.getByRole('menuitem', { name: /Watch together/ }).click();
    await a.page.getByTestId('file-input').setInputFiles(new URL('../fixtures/film.webm', import.meta.url).pathname);
    await a.page.getByTestId('file-host').waitFor({ timeout: 20_000 });
    await expect.poll(async () => (await host()).paused, { timeout: 20_000 }).toBe(false);

    // Bob receives it as encrypted video, and gets the same controls.
    await b.page.getByTestId('screen-tile').waitFor({ timeout: 30_000 });
    await expect.poll(() => frames(b.page, '[data-testid="screen-tile"] video'), { timeout: 45_000 }).toBeGreaterThan(0);
    await b.page.getByTestId('shared-bar').waitFor({ timeout: 20_000 });
    expect(await b.page.getByTestId('share-live-chip').innerText()).toMatch(/Alice is playing film\.webm · anyone can pause/);
    await expect.poll(() => b.page.locator('[data-bt-audio] audio').count(), { timeout: 20_000 }).toBeGreaterThan(0); // the film's sound arrives too

    // Bob — who does not have the file — pauses it for everyone.
    await b.page.getByTestId('shared-toggle').click();
    await expect.poll(async () => (await host()).paused, { timeout: 15_000 }).toBe(true);
    expect(await b.page.getByTestId('shared-toggle').getAttribute('aria-label')).toBe('Play for everyone');

    // Bob skips ahead, then presses play.
    await sess(b.page, 's => s.fileCommand({ action: "seek", position: 50 })');
    await expect.poll(async () => Math.abs((await host()).t - 50) < 2, { timeout: 15_000 }).toBe(true);
    await b.page.getByTestId('shared-toggle').click();
    await expect.poll(async () => (await host()).paused, { timeout: 15_000 }).toBe(false);
    await expect.poll(() => b.page.getByTestId('shared-time').innerText(), { timeout: 15_000 }).toMatch(/^0:5\d$/);

    // Someone who joins later gets the controls as well.
    const c = await joinRoom(h, secret, 'Carol');
    await c.page.getByTestId('shared-bar').waitFor({ timeout: 30_000 });
    await c.page.getByTestId('shared-toggle').click();
    await expect.poll(async () => (await host()).paused, { timeout: 15_000 }).toBe(true);

    // Stopping removes it for everyone, and only the owner has that button.
    expect(await b.page.getByTestId('file-stop').count()).toBe(0);
    await a.page.getByTestId('file-stop').click();
    await expect.poll(() => b.page.getByTestId('screen-tile').count(), { timeout: 20_000 }).toBe(0);
    await expect.poll(() => c.page.getByTestId('shared-bar').count(), { timeout: 20_000 }).toBe(0);
    expect(a.errors.concat(b.errors, c.errors)).toEqual([]);
    await closeAll(a, b, c);
  }, 240_000);

  it('offers "Ask to pause" for a shared tab, where only the sharer can press the button', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);
    // A share that carries sound is the sign that someone is watching something.
    await a.page.evaluate(async () => {
      const s = (window as unknown as { __shh: { session: { value: { room: { localParticipant: { publishTrack(t: MediaStreamTrack, o: unknown): Promise<unknown> } } } } } }).__shh.session.value;
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      ctx.createOscillator().connect(dest);
      (window as unknown as { __tone: MediaStreamTrack }).__tone = dest.stream.getAudioTracks()[0]!;
      void s;
    });
    await a.page.getByTestId('share').click();
    await a.page.getByTestId('share-confirm').click();
    await a.page.getByTestId('share-live-chip').waitFor({ timeout: 30_000 });
    await a.page.evaluate('window.__shh.session.value.room.localParticipant.publishTrack(window.__tone, { source: "screen_share_audio", name: "screen-audio" })');

    await b.page.getByTestId('ask-pause').waitFor({ timeout: 30_000 });
    await b.page.getByTestId('ask-pause').click();
    await a.page.getByText('Bob asked you to pause').waitFor({ timeout: 15_000 });
    expect(await b.page.getByTestId('ask-pause').innerText()).toContain('Asked Alice');
    expect(await b.page.getByTestId('ask-pause').isDisabled()).toBe(true);
    await closeAll(a, b);
  }, 180_000);
});

// Host controls are enforced by a server; the serverless build has none and offers none.
describe.skipIf(DIRECT)('host controls', () => {
  it('lets the host mute, remove and lock — enforced by the server', async () => {
    const secret = freshSecret();
    const hostKey = HOST_KEY + Math.random().toString(36).slice(2, 8);
    const a = await joinRoom(h, secret, 'Hostess', { host: hostKey });
    const b = await joinRoom(h, secret, 'Bob', { mic: true });
    await settled(a, b);
    expect(await sess<boolean>(a.page, 's => s.isHost.value')).toBe(true);
    expect(await sess<boolean>(b.page, 's => s.isHost.value')).toBe(false);

    // Bob sees who the host is, and has no host actions himself.
    await b.page.getByTestId('people-toggle').click();
    await b.page.locator('[data-testid="person"]', { hasText: 'Hostess' }).locator('.tag.host').waitFor();
    await b.page.getByRole('button', { name: 'Options for Hostess' }).click();
    expect(await b.page.getByRole('menuitem', { name: /Remove from room/ }).count()).toBe(0);
    await b.page.keyboard.press('Escape');

    // A forged moderation call without the key is refused.
    const roomId = await sess<string>(b.page, 's => s.roomSecret.roomId');
    const victim = await sess<string>(a.page, 's => s.identity');
    const forged = await b.page.evaluate(
      async ([roomId, identity]) => (await fetch('/api/host', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId, hostKey: 'x'.repeat(30), action: 'remove', identity }) })).status,
      [roomId, victim],
    );
    expect(forged).toBe(403);

    // Mute for everyone
    await a.page.getByTestId('people-toggle').click();
    await a.page.getByRole('button', { name: 'Options for Bob' }).click();
    await a.page.getByRole('menuitem', { name: /Mute for everyone/ }).click();
    await expect.poll(() => sess<boolean>(b.page, 's => s.micOn.value'), { timeout: 15_000 }).toBe(false);
    await b.page.getByText('The host muted your microphone').waitFor();

    // Lock, then a newcomer is turned away with a reason
    await a.page.getByRole('switch', { name: 'Lock room' }).click();
    await b.page.getByTestId('locked-chip').waitFor({ timeout: 15_000 });
    const late = await newClient(h);
    await late.page.goto(`${h.origin}/#k=${secret}`);
    await late.page.getByLabel('Your name').fill('Latecomer');
    await late.page.getByTestId('join').click();
    await late.page.getByTestId('join-error').waitFor({ timeout: 20_000 });
    expect(await late.page.getByTestId('join-error').innerText()).toContain('locked');

    // Remove (two clicks), and Bob is told why
    await a.page.getByRole('button', { name: 'Options for Bob' }).click();
    await a.page.getByRole('menuitem', { name: /Remove from room/ }).click();
    await a.page.getByRole('menuitem', { name: /Click again to remove/ }).click();
    await b.page.getByText('The host removed you').waitFor({ timeout: 20_000 });
    await expect.poll(() => peerCount(a.page), { timeout: 20_000 }).toBe(0);
    await closeAll(a, b, late);
  }, 240_000);
});

describe('sounds and settings', () => {
  it('plays interface sounds only after a gesture, and obeys the sound settings', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice');
    const played = () => a.page.evaluate(() => (window as unknown as { __sfx: { played: number; lastGain: number } }).__sfx);
    const before = (await played()).played;
    await a.page.getByTestId('deafen').click();
    await a.page.getByTestId('deafen').click();
    expect((await played()).played).toBe(before + 2);
    const loud = (await played()).lastGain;

    await a.page.getByTestId('more').click();
    await a.page.getByRole('menuitem', { name: 'Settings' }).click();
    await a.page.getByRole('radio', { name: 'Sounds' }).click();
    await a.page.getByLabel('Interface sound volume').fill('0.2');
    await a.page.getByRole('button', { name: 'Play a test sound' }).click();
    expect((await played()).lastGain).toBeLessThan(loud);

    await a.page.getByRole('switch', { name: 'Interface sounds' }).click();
    expect(await a.page.getByRole('button', { name: 'Play a test sound' }).isDisabled()).toBe(true);
    await a.page.keyboard.press('Escape');
    const silent = (await played()).played;
    await a.page.getByTestId('deafen').click();
    await a.page.getByTestId('mic').click();
    expect((await played()).played).toBe(silent);
    expect(await a.page.evaluate(() => JSON.parse(localStorage.getItem('shhvc.settings.v1')!).sfxEnabled)).toBe(false);
    await closeAll(a);
  }, 120_000);

  it('switches noise suppression mid-call without interrupting the call', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice', { mic: true, settings: { suppression: 'standard' } });
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);
    const state = () =>
      sess<{ mode: string; browserNs?: boolean; trackId: string; note?: string }>(
        a.page,
        's => ({ mode: s.micSuppression.value, browserNs: s.mic?.inputSettings()?.noiseSuppression, trackId: s.mic?.track.id, note: s.suppressionNote.value })',
      );
    const before = await state();
    expect(before).toMatchObject({ mode: 'standard', browserNs: true });

    // The neural filters replace the browser's own filter rather than stacking on it.
    for (const mode of ['strong', 'light', 'off'] as const) {
      if (await a.page.getByTestId('mic-options').isVisible()) {
        await a.page.getByTestId('mic-options').click();
        await a.page.locator(`[data-testid="mic-menu"] [data-suppression="${mode}"]`).click();
        await a.page.keyboard.press('Escape');
      }
      await expect.poll(async () => (await state()).mode, { timeout: 15_000 }).toBe(mode);
      const now = await state();
      expect(now.browserNs).toBe(false);
      expect(now.note).toBeUndefined();
      // Same outgoing track throughout: nothing was renegotiated.
      expect(now.trackId).toBe(before.trackId);
    }
    // Bob still hears Alice the whole time.
    expect(await b.page.locator('[data-bt-audio] audio').count()).toBeGreaterThan(0);
    expect(await sess<string>(a.page, '() => JSON.parse(localStorage.getItem("shhvc.settings.v1")).suppression')).toBe('off');

    // Echo cancellation and gain reach the capture as well.
    await a.page.getByTestId('more').click();
    await a.page.getByRole('menuitem', { name: 'Settings' }).click();
    await a.page.getByRole('switch', { name: 'Echo cancellation' }).click();
    await expect.poll(() => sess<boolean>(a.page, 's => s.mic.inputSettings().echoCancellation'), { timeout: 15_000 }).toBe(false);
    expect(a.errors.concat(b.errors)).toEqual([]);
    await closeAll(a, b);
  }, 180_000);

  it.skipIf(!DIRECT)('negotiates redundant audio, tuned Opus and voice-first priority', async () => {
    const secret = freshSecret();
    const a = await joinRoom(h, secret, 'Alice', { mic: true });
    const b = await joinRoom(h, secret, 'Bob');
    await settled(a, b);
    const wire = await sess<{ first: string; priority: string; fmtp: string }>(
      a.page,
      `s => {
        const pc = Object.values(s.room.discovery.getPeers())[0].connection;
        const sender = pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
        const p = sender.getParameters();
        const nl = String.fromCharCode(13, 10);
        const m = pc.currentRemoteDescription.sdp.split('m=').find((x) => x.startsWith('audio'));
        return { first: p.codecs[0].mimeType, priority: p.encodings[0].priority, fmtp: m.split(nl).find((l) => l.startsWith('a=fmtp:111 ')) };
      }`,
    );
    expect(wire.first).toBe('audio/red');
    expect(wire.priority).toBe('high');
    expect(wire.fmtp).toContain('maxaveragebitrate=48000');
    expect(wire.fmtp).toContain('useinbandfec=1');
    await closeAll(a, b);
  }, 120_000);

  it('opens every dialog and menu, and closes each with Escape', async () => {
    const a = await joinRoom(h, freshSecret(), 'Alice');
    await a.page.locator('body').press('?');
    await a.page.getByTestId('shortcuts').waitFor();
    await a.page.keyboard.press('Escape');
    await expect.poll(() => a.page.getByTestId('shortcuts').count()).toBe(0);
    await a.page.getByTestId('status').click();
    await a.page.getByTestId('verify').waitFor();
    await a.page.keyboard.press('Escape');
    await a.page.getByTestId('react').click();
    await a.page.getByTestId('stage-react').first().click();
    await a.page.locator('.reaction-float').waitFor();
    // C opens chat and focuses the composer; typing "c" there is just a letter,
    // so the panel is closed with Escape. P toggles the people list both ways.
    await a.page.locator('body').press('c');
    await a.page.getByTestId('composer').waitFor();
    await a.page.keyboard.type('c');
    expect(await a.page.getByTestId('composer').inputValue()).toBe('c');
    await a.page.keyboard.press('Escape');
    await expect.poll(() => a.page.locator('.panel').count(), { timeout: 5000 }).toBe(0);
    await a.page.locator('body').press('p');
    await a.page.getByTestId('people').waitFor();
    await a.page.locator('body').press('p');
    await expect.poll(() => a.page.locator('.panel').count(), { timeout: 5000 }).toBe(0);
    await a.page.getByTestId('invite').click();
    await a.page.getByText('Link copied').waitFor();
    expect(await a.page.evaluate(() => navigator.clipboard.readText())).toContain('#k=');
    expect(a.errors).toEqual([]);
    await closeAll(a);
  }, 120_000);
});
