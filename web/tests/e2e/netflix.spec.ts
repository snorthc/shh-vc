/**
 * Watching on everyone's own account: the shared clock, the host's rule, and
 * the bookmarklet linking a (stand-in) Netflix tab to the call.
 *
 * The stand-in page lives on a different origin (localhost vs 127.0.0.1) and
 * exposes the same player controls Netflix's page does. Real Netflix cannot be
 * reached from the test machine.
 */
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, DIRECT, type Harness, joinRoom, newClient, startHarness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  if (DIRECT) h = await startHarness();
}, 120_000);
afterAll(() => h?.close());

const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
};

/** Create a room as its host; returns the host's client and the invite fragment for others. */
async function hostRoom(name: string): Promise<{ host: Client; secret: string; extra: string }> {
  const c = await newClient(h);
  await c.page.goto(h.origin);
  await c.page.getByTestId('start-room').click();
  const invite = await c.page.locator('.prejoin-form input[readonly]').inputValue();
  await c.page.getByLabel('Your name').fill(name);
  await c.page.getByTestId('join').click();
  await c.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });
  const m = /#k=([^&]+)(.*)$/.exec(invite)!;
  return { host: c, secret: m[1]!, extra: m[2]! };
}

async function startOwn(page: Page, title: string): Promise<void> {
  await page.getByTestId('more').click();
  await page.getByRole('menuitem', { name: /Watch together/ }).click();
  await page.getByTestId('own-title-input').fill(title);
  await page.getByTestId('own-start').click();
}

/** Open the stand-in Netflix page and click the bookmarklet as it was built into the room. */
async function linkNetflix(viewer: Client, path = '/__netflix/watch/80057281'): Promise<{ tab: Page; popup?: Page }> {
  await viewer.page.getByTestId('own-setup-toggle').click();
  const href = (await viewer.page.getByTestId('bookmarklet').getAttribute('href'))!;
  expect(href.startsWith('javascript:')).toBe(true);
  // The bookmarklet must not carry the room secret anywhere.
  const secret = /#k=([^&]+)/.exec(viewer.page.url())![1]!;
  expect(decodeURIComponent(href)).not.toContain(secret);
  const tab = await viewer.ctx.newPage();
  await tab.goto(`${h.origin.replace('127.0.0.1', 'localhost')}${path}`);
  await tab.evaluate(() => (document.getElementById('v') as HTMLVideoElement).play());
  await tab.evaluate((code) => {
    const b = document.createElement('button');
    b.id = 'bookmark';
    b.textContent = 'bookmark';
    // Stands in for clicking a bookmark: a user gesture that runs the code in this page.
    b.onclick = () => (0, eval)(code);
    document.body.append(b);
  }, decodeURIComponent(href.slice('javascript:'.length)));
  const popupPromise = viewer.ctx.waitForEvent('page', { timeout: 5000 }).catch(() => undefined);
  await tab.click('#bookmark');
  return { tab, popup: await popupPromise };
}

const nf = (tab: Page) =>
  tab.evaluate(() => {
    const v = document.getElementById('v') as HTMLVideoElement;
    return { playing: !v.paused, position: v.currentTime, direct: (window as unknown as { __direct: number }).__direct };
  });

/** Screenshots for a person to review, only when asked for. */
async function page_shots(...pages: Page[]): Promise<void> {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  for (const [i, p] of pages.entries()) await p.screenshot({ path: `${dir}/netflix-${i}.png` });
}

describe.skipIf(!DIRECT)('watching on everyone’s own account', () => {
  it('keeps a shared clock, links a Netflix tab, and follows the host’s rule', async () => {
    const { host: a, secret, extra } = await hostRoom('Hana');
    const b = await joinRoom(h, secret, 'Ben', { extra });
    await a.page.locator('[data-testid="tile-peer"]').waitFor({ timeout: 30_000 });

    await startOwn(a.page, 'Test Show');
    await b.page.getByTestId('own-title').getByText('Test Show').waitFor({ timeout: 10_000 });

    // Ben links his Netflix tab: the pop-up opens and his call says it is linked.
    const { tab, popup } = await linkNetflix(b);
    expect(popup).toBeDefined();
    await popup!.getByText('In sync with your call').waitFor({ timeout: 10_000 });
    await b.page.getByTestId('own-linked').waitFor({ timeout: 10_000 });
    // The room was paused at 0:00, so his Netflix is paused there too.
    await until(async () => !(await nf(tab)).playing);

    // Hana jumps everyone to 0:05 and presses play: a count-in, then Ben's Netflix plays from there.
    await a.page.getByTestId('own-jump').fill('0:05');
    await a.page.getByTestId('own-jump').press('Enter');
    await a.page.getByTestId('own-toggle').click();
    expect(await b.page.getByTestId('own-clock').getAttribute('data-counting')).toBe('true');
    await until(async () => {
      const s = await nf(tab);
      return s.playing && s.position > 5 && s.position < 9;
    });
    // Skipping went through Netflix's own controls, never the video element.
    expect((await nf(tab)).direct).toBe(0);

    // Ben pauses on Netflix itself: the room pauses for Hana.
    await tab.evaluate(() => (document.getElementById('v') as HTMLVideoElement).pause());
    await a.page.getByTestId('own-state').getByText('Paused').waitFor({ timeout: 10_000 });

    // Hana makes it host-only. Ben's play on Netflix is put back, and the room stays paused.
    await a.page.getByTestId('control-level').selectOption('host');
    await b.page.getByText('host controls playback').waitFor({ timeout: 15_000 });
    expect(await b.page.getByTestId('own-toggle').isDisabled()).toBe(true);
    await tab.evaluate(() => (document.getElementById('v') as HTMLVideoElement).play());
    await until(async () => !(await nf(tab)).playing);
    expect(await a.page.getByTestId('own-state').innerText()).toContain('Paused');

    // A modified app cannot get round it: an unsigned command from Ben is ignored by Hana.
    await b.page.evaluate(() => {
      const s = (window as unknown as { __shh: { session: { value: { sendApp(m: unknown): Promise<void>; movie: { value: { rev: number } } } } } }).__shh.session.value;
      return s.sendApp({ t: 'movie', state: { url: 'own', kind: 'own', title: 'Hijack', playing: true, position: 99, rev: s.movie.value.rev + 5, by: 'x' } });
    });
    await a.page.waitForTimeout(1500);
    expect(await a.page.getByTestId('own-title').innerText()).toBe('Test Show');

    // When Hana plays, Ben's Netflix follows even though he cannot press play himself.
    await a.page.getByTestId('own-toggle').click();
    await until(async () => (await nf(tab)).playing);

    // Ben can ask to pause instead.
    await b.page.getByTestId('own-ask').click();
    await a.page.getByText('Ben asked to pause').waitFor({ timeout: 10_000 });

    // Ben's Netflix moves to the next episode by itself, but only the host may change what is on:
    // Ben is offered a way back to the room's episode instead.
    await tab.evaluate(() => history.pushState(null, '', '/__netflix/watch/80057282'));
    await b.page.getByTestId('own-go').waitFor({ timeout: 10_000 });
    await popup!.getByText('is on another episode').waitFor({ timeout: 10_000 });
    await b.page.getByTestId('own-go').getByRole('button', { name: 'Go there' }).click();
    await tab.waitForURL(/\/watch\/80057281$/, { timeout: 10_000 });

    await page_shots(a.page, b.page, popup!);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    await a.ctx.close();
    await b.ctx.close();
  }, 180_000);

  it('opens control to everyone 30 seconds after the host leaves', async () => {
    const { host: a, secret, extra } = await hostRoom('Hana');
    const b = await joinRoom(h, secret, 'Ben', { extra });
    await a.page.locator('[data-testid="tile-peer"]').waitFor({ timeout: 30_000 });
    await startOwn(a.page, 'Late Show');
    await a.page.getByTestId('control-level').selectOption('host');
    await b.page.getByText('host controls playback').waitFor({ timeout: 15_000 });
    await a.ctx.close();
    await b.page.getByText('anyone can pause').first().waitFor({ timeout: 45_000 });
    expect(await b.page.getByTestId('own-toggle').isDisabled()).toBe(false);
    await b.ctx.close();
  }, 120_000);

  it('says so on the page when a site cuts off the link window', async () => {
    const { host: a } = await hostRoom('Hana');
    await startOwn(a.page, 'Blocked');
    const { tab } = await linkNetflix(a, '/__netflix-coop/watch/1');
    await tab.getByText('blocked the link').waitFor({ timeout: 10_000 });
    await a.ctx.close();
  }, 120_000);
});
