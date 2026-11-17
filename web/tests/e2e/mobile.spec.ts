/**
 * Phone-sized viewports, with touch emulation, against the live stack.
 * Checks layout integrity (no overflow, nothing clipped, nothing tiny) and
 * that the phone-specific interactions actually work.
 */
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshSecret, type Harness, joinRoom, newClient, stackReachable, startHarness } from './harness.ts';

const PHONES = [
  { name: 'iPhone-sized 390×844', viewport: { width: 390, height: 844 } },
  { name: 'small Android 360×640', viewport: { width: 360, height: 640 } },
];

let h: Harness;
beforeAll(async () => {
  if (!(await stackReachable())) throw new Error('local stack not running: start it with ./dev-stack.sh');
  h = await startHarness();
}, 120_000);
afterAll(() => h?.close());

/** Layout problems a person would notice, measured rather than eyeballed. */
async function audit(page: Page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > vw + 1) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`);
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="switch"], [role="radio"]')) {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue; // scrolled out of view is fine
      const label = (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 30);
      if (r.left < -1 || r.right > vw + 1) problems.push(`clipped horizontally: ${label}`);
      if (el.matches('.dock-btn, .dock button') && (r.width < 44 || r.height < 44)) problems.push(`touch target too small: ${label} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim();
      const el = node.parentElement;
      if (!text || !el || !visible(el) || el.closest('[aria-hidden="true"], .sr-only, .badge')) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 11) problems.push(`tiny text (${size}px): ${text.slice(0, 24)}`);
    }
    return problems;
  });
}

for (const phone of PHONES) {
  describe(phone.name, () => {
    const opts = { viewport: phone.viewport, mobile: true, scale: 2 };

    it('landing and pre-join fit the screen with nothing clipped', async () => {
      const c = await newClient(h, opts);
      await c.page.goto(h.origin, { waitUntil: 'load' });
      expect(await audit(c.page)).toEqual([]);
      const start = await c.page.getByTestId('start-room').boundingBox();
      expect(start!.height).toBeGreaterThanOrEqual(44);
      expect(start!.y + start!.height).toBeLessThan(phone.viewport.height); // the main action is above the fold

      await c.page.getByTestId('start-room').tap();
      await c.page.getByLabel('Your name').waitFor();
      expect(await audit(c.page)).toEqual([]);
      const join = await c.page.getByTestId('join').boundingBox();
      expect(join!.height).toBeGreaterThanOrEqual(44);
      expect(c.errors).toEqual([]);
      await c.ctx.close();
    }, 120_000);

    it('the room, its controls, chat sheet and menus all work by touch', async () => {
      const secret = freshSecret();
      const desk = await joinRoom(h, secret, 'Desk', { camera: true });
      const m = await joinRoom(h, secret, 'Mobi', { ...opts, camera: true });
      await m.page.locator('[data-testid="tile-peer"]').waitFor({ timeout: 30_000 });
      // The bottom bar slides up on arrival; measure once it has settled.
      await expect
        .poll(async () => (await m.page.getByTestId('mic').boundingBox())!.y + 48, { timeout: 5000 })
        .toBeLessThanOrEqual(phone.viewport.height);
      await m.page.waitForTimeout(200);
      expect(await audit(m.page)).toEqual([]);

      // The controls that matter most are in the bottom bar, within the viewport.
      for (const id of ['mic', 'deafen', 'camera', 'chat-toggle', 'more']) {
        const box = await m.page.getByTestId(id).boundingBox();
        expect(box, id).not.toBeNull();
        expect(box!.width, id).toBeGreaterThanOrEqual(44);
        expect(box!.height, id).toBeGreaterThanOrEqual(44);
        expect(box!.y + box!.height, id).toBeLessThanOrEqual(phone.viewport.height);
        expect(box!.y, id).toBeGreaterThan(phone.viewport.height * 0.7); // thumb reach
      }
      await m.page.getByTestId('leave').waitFor();

      // Mute and deafen by tap
      await m.page.getByTestId('deafen').tap();
      await m.page.getByTestId('deafen-banner').waitFor();
      expect(await audit(m.page)).toEqual([]);
      await m.page.getByTestId('deafen').tap();

      // Chat as a bottom sheet
      await m.page.getByTestId('chat-toggle').tap();
      await m.page.getByTestId('composer').waitFor();
      await m.page.waitForTimeout(500);
      expect(await audit(m.page)).toEqual([]);
      const composer = await m.page.getByTestId('composer').boundingBox();
      expect(composer!.y + composer!.height).toBeLessThanOrEqual(phone.viewport.height);
      expect(await m.page.getByTestId('composer').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16); // no iOS focus zoom
      await m.page.getByTestId('composer').fill('hello from a phone');
      await m.page.getByTestId('send').tap();
      await desk.page.getByTestId('chat-toggle').click();
      await desk.page.getByText('hello from a phone').waitFor({ timeout: 20_000 });

      // Tapping a message reveals its actions (there is no hover on a phone)
      await m.page.locator('.msg').first().tap();
      await m.page.locator('.msg').first().getByTestId('msg-reply').waitFor();

      // Drag the sheet down to dismiss it
      const head = await m.page.locator('.panel-grabber').boundingBox();
      const x = head!.x + head!.width / 2;
      await m.page.mouse.move(x, head!.y + 2);
      await m.page.mouse.down();
      for (let i = 1; i <= 8; i++) await m.page.mouse.move(x, head!.y + i * 45, { steps: 2 });
      await m.page.mouse.up();
      await expect.poll(() => m.page.locator('.panel').count(), { timeout: 5000 }).toBe(0);

      // A short drag springs back instead of closing
      await m.page.getByTestId('chat-toggle').tap();
      await m.page.getByTestId('composer').waitFor();
      await m.page.waitForTimeout(500);
      const head2 = await m.page.locator('.panel-grabber').boundingBox();
      await m.page.mouse.move(x, head2!.y + 2);
      await m.page.mouse.down();
      await m.page.mouse.move(x, head2!.y + 40, { steps: 8 });
      await m.page.waitForTimeout(250);
      await m.page.mouse.up();
      await m.page.waitForTimeout(600);
      expect(await m.page.locator('.panel').count()).toBe(1);
      await m.page.getByTestId('panel-close').tap();
      await expect.poll(() => m.page.locator('.panel').count(), { timeout: 5000 }).toBe(0);

      // More menu and settings sheet stay inside the viewport
      await m.page.getByTestId('more').tap();
      const menu = await m.page.getByTestId('more-menu').boundingBox();
      expect(menu!.x).toBeGreaterThanOrEqual(0);
      expect(menu!.x + menu!.width).toBeLessThanOrEqual(phone.viewport.width);
      expect(menu!.y).toBeGreaterThanOrEqual(0);
      expect(menu!.y + menu!.height).toBeLessThanOrEqual(phone.viewport.height);
      await m.page.getByRole('menuitem', { name: `People · 2` }).tap();
      await m.page.getByTestId('people').waitFor();
      expect(await audit(m.page)).toEqual([]);
      await m.page.getByTestId('panel-close').tap();
      await m.page.getByTestId('more').tap();
      await m.page.getByRole('menuitem', { name: 'Settings' }).tap();
      await m.page.getByTestId('settings').waitFor();
      await m.page.waitForTimeout(500);
      const sheet = await m.page.getByTestId('settings').boundingBox();
      expect(sheet!.x).toBe(0);
      expect(sheet!.width).toBe(phone.viewport.width);
      expect(sheet!.y).toBeGreaterThanOrEqual(0);
      expect(await audit(m.page)).toEqual([]);
      for (const tab of ['Profile', 'Sharing', 'Sounds']) {
        await m.page.getByRole('radio', { name: tab }).tap();
        expect(await audit(m.page), tab).toEqual([]);
      }
      await m.page.keyboard.press('Escape');

      // Watching someone else's share on a phone
      // Make sure the desktop's side panel is fully closed before using its dock.
      await desk.page.evaluate(() => (document.querySelector('[data-testid="panel-close"]') as HTMLElement | null)?.click());
      await expect.poll(() => desk.page.locator('.panel').count(), { timeout: 5000 }).toBe(0);
      await desk.page.getByTestId('share').click();
      await desk.page.getByTestId('share-confirm').click();
      await m.page.getByTestId('screen-tile').waitFor({ timeout: 30_000 });
      await expect
        .poll(() => m.page.evaluate(() => (document.querySelector('[data-testid="screen-tile"] video') as HTMLVideoElement).videoWidth), { timeout: 45_000 })
        .toBeGreaterThan(0);
      await m.page.waitForTimeout(600);
      expect(await audit(m.page)).toEqual([]);
      const tile = await m.page.getByTestId('screen-tile').boundingBox();
      expect(tile!.width).toBeGreaterThan(phone.viewport.width * 0.9);

      expect(m.errors).toEqual([]);
      await desk.ctx.close();
      await m.ctx.close();
    }, 240_000);
  });
}

describe('phones cannot capture a screen', () => {
  it('says so plainly instead of offering a control that does nothing', async () => {
    const c = await newClient(h, { viewport: { width: 390, height: 844 }, mobile: true });
    // Mobile browsers do not implement getDisplayMedia; emulate that.
    await c.page.addInitScript(() => {
      Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', { value: undefined, configurable: true });
    });
    await c.page.goto(`${h.origin}/#k=${freshSecret()}`);
    await c.page.getByLabel('Your name').fill('Phone');
    await c.page.getByTestId('join').tap();
    await c.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });
    await c.page.getByTestId('more').tap();
    const item = c.page.getByRole('menuitem', { name: /Share screen/ });
    expect(await item.isDisabled()).toBe(true);
    expect(await item.innerText()).toContain('cannot capture the screen');
    // Everything else still works.
    expect(await c.page.getByRole('menuitem', { name: /Watch together/ }).isEnabled()).toBe(true);
    await c.ctx.close();
  }, 120_000);
});
