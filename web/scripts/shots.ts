/**
 * Screenshot tour of the app at desktop and phone sizes, against the live
 * local stack. Run: npx vitest run --config vitest.shots.config.ts
 */
import { mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { freshSecret, HOST_KEY, joinRoom, newClient, startHarness } from '../tests/e2e/harness.ts';

const OUT = process.env.SHOTS_DIR ?? '/tmp/shhvc-shots';
mkdirSync(OUT, { recursive: true });
const only = (process.env.SHOTS ?? '').split(',').filter(Boolean);
const want = (name: string) => only.length === 0 || only.some((o) => name.startsWith(o));

const DESK = { viewport: { width: 1440, height: 900 }, scale: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, scale: 3, mobile: true };

test('screens', async () => {
  const h = await startHarness({ tabCaptureTitle: 'Launch plan' });
  const shot = async (page: import('playwright').Page, name: string, full = false) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  };
  try {
    for (const [tag, size] of [['d', DESK], ['m', PHONE]] as const) {
      if (want(`${tag}-landing`)) {
        const c = await newClient(h, size);
        await c.page.goto(h.origin, { waitUntil: 'load' });
        await c.page.waitForTimeout(1600);
        await shot(c.page, `${tag}-landing`);
        await shot(c.page, `${tag}-landing-full`, true);
        await c.ctx.close();
      }
      if (want(`${tag}-prejoin`)) {
        const c = await newClient(h, size);
        await c.page.goto(h.origin, { waitUntil: 'load' });
        await c.page.getByTestId('start-room').click();
        await c.page.getByLabel('Your name').fill('Sam Okafor');
        await c.page.locator('.preview-controls .dock-btn').nth(1).click();
        await c.page.waitForTimeout(1500);
        await shot(c.page, `${tag}-prejoin`);
        await c.ctx.close();
      }
    }

    if (want('d-room') || want('m-room')) {
      const secret = freshSecret();
      const sam = await joinRoom(h, secret, 'Sam Okafor', { ...DESK, host: HOST_KEY, camera: true, mic: true });
      const priya = await joinRoom(h, secret, 'Priya Nair', { ...DESK, scale: 1, camera: true, mic: false });
      const jonas = await joinRoom(h, secret, 'Jonas Weber', { ...DESK, scale: 1, camera: false, mic: true });
      const mob = await joinRoom(h, secret, 'Mei Tanaka', { ...PHONE, camera: true, mic: true });
      await sam.page.waitForTimeout(5000);
      await shot(sam.page, 'd-room-grid');
      await shot(mob.page, 'm-room-grid');

      // chat
      await sam.page.getByTestId('chat-toggle').click();
      await priya.page.getByTestId('chat-toggle').click();
      await jonas.page.getByTestId('chat-toggle').click();
      const say = async (c: typeof sam, text: string) => {
        await c.page.getByTestId('composer').fill(text);
        await c.page.getByTestId('send').click();
        await c.page.waitForTimeout(350);
      };
      await say(priya, 'Morning! Can everyone see the plan?');
      await say(priya, 'I moved the beta to week two.');
      await say(sam, 'Looks good. Sharing my screen in a sec so we can go through it.');
      await say(jonas, '👍');
      await say(jonas, 'One question on the timeline — is week three enough for the fix list? https://example.com/fix-list');
      await priya.page.locator('[data-testid="message"]').nth(2).hover();
      await priya.page.locator('[data-testid="message"]').nth(2).getByTestId('msg-reply').click();
      await say(priya, 'Great, go ahead.');
      await sam.page.locator('[data-testid="message"]').nth(1).hover();
      await sam.page.locator('[data-testid="message"]').nth(1).getByTestId('msg-react').click();
      await sam.page.locator('.emoji-pop .emoji-cell').first().click();
      await jonas.page.getByTestId('composer').fill('typing something');
      await jonas.page.getByTestId('composer').press('End');
      await jonas.page.keyboard.type(' …');
      await sam.page.locator('[data-testid="message"]').nth(4).hover();
      await shot(sam.page, 'd-room-chat');

      await mob.page.getByTestId('chat-toggle').click();
      await shot(mob.page, 'm-room-chat');
      await mob.page.getByTestId('panel-close').click();

      // people
      await sam.page.keyboard.press('Escape');
      await sam.page.locator('body').click({ position: { x: 300, y: 300 } });
      await sam.page.getByTestId('people-toggle').click();
      await shot(sam.page, 'd-room-people');
      await sam.page.getByTestId('panel-close').click();

      // deafen + mute
      await sam.page.getByTestId('deafen').click();
      await shot(sam.page, 'd-room-deafened');
      await sam.page.getByTestId('deafen').click();

      // share preview
      const doc = await sam.ctx.newPage();
      await doc.goto(`${h.origin}/__doc`);
      await sam.page.bringToFront();
      await sam.page.getByTestId('share').click();
      await sam.page.getByTestId('share-preview-video').waitFor();
      await sam.page.waitForTimeout(2500);
      await shot(sam.page, 'd-share-preview');
      await sam.page.getByTestId('share-confirm').click();
      await sam.page.getByTestId('share-live-chip').waitFor({ timeout: 20000 });
      await priya.page.getByTestId('screen-tile').waitFor({ timeout: 20000 });
      await priya.page.waitForTimeout(4000);
      await priya.page.keyboard.press('Escape');
      await priya.page.getByTestId('panel-close').click().catch(() => undefined);
      await shot(priya.page, 'd-share-presentation');
      await priya.page.getByTestId('diag-toggle').click();
      await priya.page.waitForTimeout(2500);
      await shot(priya.page, 'd-share-diagnostics');
      await priya.page.getByTestId('diag-toggle').click();
      await shot(mob.page, 'm-share-viewing');
      for (const layout of ['Theatre', 'Social', 'Cinema']) {
        await priya.page.getByRole('radio', { name: layout }).click();
        await priya.page.mouse.move(700, 400);
        await priya.page.waitForTimeout(900);
        await shot(priya.page, `d-share-${layout.toLowerCase()}`);
      }
      await priya.page.getByRole('radio', { name: 'Presentation' }).click();
      await sam.page.waitForTimeout(600);
      await shot(sam.page, 'd-share-sender');
      await sam.page.getByTestId('share-stop').click();

      // settings + more menu
      await sam.page.getByTestId('more').click();
      await shot(sam.page, 'd-more-menu');
      await sam.page.getByRole('menuitem', { name: 'Settings' }).click();
      await shot(sam.page, 'd-settings-devices');
      await sam.page.getByRole('radio', { name: 'Sharing' }).click();
      await shot(sam.page, 'd-settings-share');
      await sam.page.keyboard.press('Escape');
      await sam.page.getByTestId('status').click();
      await shot(sam.page, 'd-verify');
      await sam.page.keyboard.press('Escape');

      await mob.page.getByTestId('more').click();
      await shot(mob.page, 'm-more-menu');
      await mob.page.getByRole('menuitem', { name: 'Settings' }).click();
      await shot(mob.page, 'm-settings');
      await mob.page.keyboard.press('Escape');

      // watch together
      await sam.page.getByTestId('more').click();
      await sam.page.getByRole('menuitem', { name: /Watch together/ }).click();
      await sam.page.getByLabel('Link to a video file').fill(`${h.origin}/__media/film.webm`);
      await shot(sam.page, 'd-watch-dialog');
      await sam.page.getByTestId('watch-start').click();
      await sam.page.getByTestId('movie-toggle').click();
      await priya.page.getByTestId('movie').waitFor({ timeout: 15000 });
      await priya.page.waitForTimeout(3000);
      await priya.page.getByRole('radio', { name: 'Theatre' }).click();
      await priya.page.getByTestId('react').click();
      await priya.page.getByTestId('stage-react').nth(1).click();
      await jonas.page.keyboard.press('Escape');
      await priya.page.waitForTimeout(500);
      await shot(priya.page, 'd-movie-theatre');
      await shot(mob.page, 'm-movie');

      // A file played from one device, with shared controls
      await sam.page.getByTestId('movie-close').click();
      await sam.page.getByTestId('more').click();
      await sam.page.getByRole('menuitem', { name: /Watch together/ }).click();
      await sam.page.getByTestId('file-input').setInputFiles(new URL('../tests/fixtures/film.webm', import.meta.url).pathname);
      await priya.page.getByTestId('shared-bar').waitFor({ timeout: 30000 });
      await priya.page.getByRole('radio', { name: 'Cinema' }).click();
      await priya.page.waitForTimeout(3500);
      await priya.page.mouse.move(720, 500);
      await shot(priya.page, 'd-file-cinema');
      await mob.page.waitForTimeout(500);
      await shot(mob.page, 'm-file');

      await sam.page.getByTestId('leave').click();
      await shot(sam.page, 'd-ended');
    }
  } finally {
    await h.close();
  }
}, 600_000);
