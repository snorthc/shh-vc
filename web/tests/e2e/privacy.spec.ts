/**
 * Privacy invariants, checked in a real browser against the production build.
 * These need no media server: the token call is stubbed and recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, newClient, startHarness } from './harness.ts';

/** A fixed, deliberately public 32-byte secret: 43 base64url chars. */
const SECRET = 'DRQbIikwNz5FTFNaYWhvdn2Ei5KZoKeutbzDytHY3-Y';

interface Seen {
  url: string;
  method: string;
  body: string | null;
  referer?: string;
}

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ stubApi: true });
}, 120_000);
afterAll(() => h?.close());

async function open(hash: string) {
  const c = await newClient(h);
  const seen: Seen[] = [];
  c.page.on('request', (r) => seen.push({ url: r.url(), method: r.method(), body: r.postData(), referer: r.headers().referer }));
  await c.page.route('**/api/token', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"no media server in this test"}' }),
  );
  await c.page.goto(`${h.origin}/${hash}`, { waitUntil: 'load' });
  return { ...c, seen };
}

async function attemptJoin(c: Awaited<ReturnType<typeof open>>, name: string) {
  await c.page.getByLabel('Your name').fill(name);
  const wait = c.page.waitForResponse((r) => r.url().includes('/api/token'), { timeout: 20_000 });
  await c.page.getByTestId('join').click();
  await wait;
  const req = c.seen.find((s) => s.url.includes('/api/token'))!;
  return { req, body: JSON.parse(req.body ?? '{}') as Record<string, string> };
}

describe('the room secret never leaves the browser', () => {
  it('sends a hashed room id and a random identity, never the secret or a name', async () => {
    const c = await open(`#k=${SECRET}`);
    const { req, body } = await attemptJoin(c, 'Tester McTest');
    expect(req.method).toBe('POST');
    expect(body.roomId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(body.identity).toMatch(/^[A-Za-z0-9_-]{16,43}$/);
    expect(req.body).not.toContain(SECRET);
    expect(req.body).not.toContain('Tester');
    expect(body.hostKey).toBeUndefined();
    await c.ctx.close();
  }, 60_000);

  it('puts the secret in no request url, body or referer', async () => {
    const c = await open(`#k=${SECRET}`);
    await attemptJoin(c, 'Tester');
    await c.page.waitForTimeout(400);
    expect(c.seen.length).toBeGreaterThan(2);
    for (const r of c.seen) {
      expect(r.url).not.toContain(SECRET);
      expect(r.body ?? '').not.toContain(SECRET);
      expect(r.referer ?? '').not.toContain(SECRET);
      expect(r.url).not.toContain('#');
    }
    await c.ctx.close();
  }, 60_000);

  it('shows a clear error and keeps the link in the address bar when joining fails', async () => {
    const c = await open(`#k=${SECRET}`);
    await attemptJoin(c, 'Tester');
    await c.page.getByTestId('join-error').waitFor();
    expect(c.page.url()).toContain(`#k=${SECRET}`);
    await c.ctx.close();
  }, 60_000);

  it('derives the same room id on independent clients, with different identities', async () => {
    const a = await open(`#k=${SECRET}`);
    const b = await open(`#k=${SECRET}`);
    const ra = await attemptJoin(a, 'A');
    const rb = await attemptJoin(b, 'B');
    expect(ra.body.roomId).toBe(rb.body.roomId);
    expect(ra.body.identity).not.toBe(rb.body.identity);
    await a.ctx.close();
    await b.ctx.close();
  }, 90_000);

  it('never writes the secret or the host key to storage', async () => {
    const c = await open('');
    await c.page.getByTestId('start-room').click();
    const { body } = await attemptJoin(c, 'Host Person');
    expect(body.hostKey).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    const url = new URL(c.page.url());
    const params = new URLSearchParams(url.hash.slice(1));
    const stored = await c.page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(stored).not.toContain(params.get('k')!);
    expect(stored).not.toContain(params.get('h')!);
    expect(stored).toContain('Host Person'); // the name is a preference, and is meant to persist
    await c.ctx.close();
  }, 60_000);

  it('keeps the host key out of the invite link', async () => {
    const c = await open('');
    await c.page.getByTestId('start-room').click();
    const invite = await c.page.getByLabel('Invite link').inputValue();
    const hostKey = new URLSearchParams(new URL(c.page.url()).hash.slice(1)).get('h')!;
    expect(hostKey.length).toBeGreaterThan(20);
    expect(invite).toContain('#k=');
    expect(invite).not.toContain(hostKey);
    expect(invite).not.toContain('h=');
    await c.ctx.close();
  }, 60_000);
});

describe('landing', () => {
  it('states plainly what is and is not hidden', async () => {
    const c = await open('');
    const text = (await c.page.locator('#app').innerText()).toLowerCase();
    expect(text).toContain('the server does see your ip address');
    expect(text).toContain('anyone with the link can join');
    await c.ctx.close();
  }, 60_000);

  it('rejects something that is not an invite link, and accepts one', async () => {
    const c = await open('');
    await c.page.getByLabel('Invite link').fill('hello there');
    await c.page.getByRole('button', { name: 'Join' }).click();
    await c.page.getByText('does not look like a BraveTalk invite link').waitFor();
    await c.page.getByLabel('Invite link').fill(`https://example.org/#k=${SECRET}`);
    await c.page.getByRole('button', { name: 'Join' }).click();
    await c.page.getByText('Ready to join?').waitFor();
    await c.ctx.close();
  }, 60_000);

  it('loads nothing from any third party', async () => {
    const c = await open('');
    await c.page.waitForTimeout(500);
    for (const r of c.seen) expect(new URL(r.url).origin).toBe(h.origin);
    await c.ctx.close();
  }, 60_000);
});
