/**
 * Privacy checks specific to the serverless build, where discovery goes
 * through relays nobody in the room controls. Runs only with E2E_MODE=direct.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIRECT, freshSecret, type Harness, joinRoom, newClient, RELAY_PORT, startHarness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  if (DIRECT) h = await startHarness();
}, 120_000);
afterAll(() => h?.close());

describe.skipIf(!DIRECT)('serverless build', () => {
  it('tells relays nothing that identifies or opens the room', async () => {
    const secret = freshSecret();
    const sent: string[] = [];
    const sockets = new Set<string>();
    const http: string[] = [];
    const a = await newClient(h);
    a.page.on('websocket', (ws) => {
      sockets.add(ws.url());
      ws.on('framesent', (f) => sent.push(String(f.payload)));
    });
    a.page.on('request', (r) => http.push(r.url()));
    await a.page.goto(`${h.origin}/#k=${secret}`);
    await a.page.getByLabel('Your name').fill('Secret Agent');
    await a.page.getByTestId('join').click();
    await a.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });
    const b = await joinRoom(h, secret, 'Bob');
    await a.page.locator('[data-testid="tile-peer"]').waitFor({ timeout: 30_000 });
    await a.page.getByTestId('chat-toggle').click();
    await a.page.getByTestId('composer').fill('a very private sentence');
    await a.page.getByTestId('composer').press('Enter');
    await b.page.waitForTimeout(1500);

    const roomId = await a.page.evaluate('window.__shh.session.value.roomSecret.roomId') as string;
    expect(sent.length).toBeGreaterThan(0);
    const everything = sent.join('\n');
    // Not the secret, not the room id derived from it, not a name, not a message.
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(roomId);
    expect(everything).not.toContain('Secret Agent');
    expect(everything).not.toContain('a very private sentence');
    // Offers are encrypted before they reach a relay: no readable SDP.
    expect(everything).not.toMatch(/a=fingerprint|a=candidate|v=0\\r\\n/);

    // The only sockets are relays, and there is no application server at all.
    expect([...sockets]).toEqual([`ws://127.0.0.1:${RELAY_PORT}/`]);
    for (const url of http) expect(new URL(url).origin).toBe(h.origin);
    expect(http.some((u) => u.includes('/api/'))).toBe(false);
    await a.ctx.close();
    await b.ctx.close();
  }, 120_000);

  it('offers no host controls, since there is no server to enforce them', async () => {
    const c = await newClient(h);
    await c.page.goto(h.origin);
    await c.page.getByTestId('start-room').click();
    expect(c.page.url()).not.toContain('h=');
    expect(await c.page.locator('.prejoin-form').innerText()).not.toContain('host');
    await c.page.getByLabel('Your name').fill('Solo');
    await c.page.getByTestId('join').click();
    await c.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });
    await c.page.getByTestId('people-toggle').click();
    expect(await c.page.getByRole('switch', { name: 'Lock room' }).count()).toBe(0);
    expect(await c.page.locator('.tag.host').count()).toBe(0);
    await c.ctx.close();
  }, 120_000);

  it('says on the pre-join screen that people in the room can see each other’s IP address', async () => {
    const c = await newClient(h);
    await c.page.goto(`${h.origin}/#k=${freshSecret()}`);
    expect(await c.page.locator('.secure-line').innerText()).toContain('can see each other’s IP address');
    await c.ctx.close();
  }, 60_000);
});
