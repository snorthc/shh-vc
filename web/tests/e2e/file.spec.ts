/**
 * The single-file build, opened straight from disk (file://) with no web
 * server at all. Runs only with E2E_MODE=file, after `npm run build:file-test`.
 */
import { existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RELAY_PORT } from './harness.ts';
import { startRelay } from './relay.ts';

const ENABLED = process.env.E2E_MODE === 'file';
const FILE = pathJoin(import.meta.dirname, '../../dist-file-test/index.html');
const URL_ = pathToFileURL(FILE).href;

let browser: Browser;
let relay: ReturnType<typeof startRelay>;

beforeAll(async () => {
  if (!ENABLED) return;
  if (!existsSync(FILE)) throw new Error('build first: npm run build:file-test');
  relay = startRelay(RELAY_PORT);
  const preinstalled = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  browser = await chromium.launch({
    ...(existsSync(preinstalled) ? { executablePath: preinstalled } : {}),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await relay?.close();
});

async function open(): Promise<{ page: Page; errors: string[]; requests: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(URL_);
  return { page, errors, requests };
}

const frames = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector('[data-testid="tile-peer"] video') as HTMLVideoElement | null;
    return v ? (v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) : -1;
  });

describe.skipIf(!ENABLED)('single file, opened from disk', () => {
  it('runs with no web server, and two people join with a room code', async () => {
    const a = await open();
    expect(await a.page.evaluate(() => location.protocol)).toBe('file:');
    expect(await a.page.locator('#app').innerText()).toContain('send the code');

    // Start a room: the invite is a code, since a file has no address to link to.
    await a.page.getByTestId('start-room').click();
    await a.page.getByLabel('Your name').fill('Alice');
    const code = await a.page.getByLabel('Room code').inputValue();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await a.page.locator('.preview-controls .dock-btn').nth(1).click(); // camera on
    await a.page.getByTestId('join').click();
    await a.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });

    // The other person opens the same file and pastes the code.
    const b = await open();
    await b.page.getByLabel('Room code').fill('nonsense');
    await b.page.getByRole('button', { name: 'Join', exact: true }).click();
    await b.page.getByText('does not look like a Shh VC room code').waitFor();
    await b.page.getByLabel('Room code').fill(code);
    await b.page.getByRole('button', { name: 'Join', exact: true }).click();
    await b.page.getByLabel('Your name').fill('Bob');
    await b.page.locator('.preview-controls .dock-btn').nth(1).click();
    await b.page.getByTestId('join').click();
    await b.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });

    // They see and hear each other, and chat works.
    await expect.poll(() => frames(a.page), { timeout: 45_000 }).toBeGreaterThan(0);
    await expect.poll(() => frames(b.page), { timeout: 45_000 }).toBeGreaterThan(0);
    expect(await a.page.locator('.tile-name').allInnerTexts()).toEqual(expect.arrayContaining(['Alice (you)', 'Bob']));
    await a.page.getByTestId('chat-toggle').click();
    await a.page.getByTestId('composer').fill('hello from a file');
    await a.page.getByTestId('composer').press('Enter');
    await b.page.getByTestId('chat-toggle').click();
    await b.page.getByText('hello from a file').waitFor({ timeout: 20_000 });

    // Screen share with the preview step works from a file too.
    await a.page.keyboard.press('Escape');
    await a.page.getByTestId('share').click();
    await a.page.getByTestId('share-private-chip').waitFor({ timeout: 20_000 });
    await a.page.getByTestId('share-confirm').click();
    await b.page.getByTestId('screen-tile').waitFor({ timeout: 30_000 });

    // Nothing was fetched from anywhere: the file is the whole app.
    for (const r of [...a.requests, ...b.requests]) expect(r.startsWith('file:') || r.startsWith('data:') || r.startsWith('blob:'), r).toBe(true);
    expect(a.errors.concat(b.errors)).toEqual([]);
  }, 240_000);
});
