/**
 * Shared end-to-end harness: serves the production build, proxies /api (HTTP
 * and WebSocket) to the local token/relay service, and launches Chromium with
 * synthetic media devices. Needs the local stack (see dev-stack.sh).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { extname, join as pathJoin, normalize } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

const ROOT = pathJoin(import.meta.dirname, '../..');
const DIST = pathJoin(ROOT, 'dist');
const FIXTURES = pathJoin(ROOT, 'tests/fixtures');
const API = { host: '127.0.0.1', port: 8787 };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.webm': 'video/webm',
};

export interface Harness {
  origin: string;
  browser: Browser;
  close(): Promise<void>;
}

export async function stackReachable(): Promise<boolean> {
  const ok = async (url: string) => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status < 500;
    } catch {
      return false;
    }
  };
  return (await ok('http://127.0.0.1:7880')) && (await ok(`http://${API.host}:${API.port}/api/health`));
}

function serveFile(path: string, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const size = statSync(path).size;
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    // Seeking in <video> needs byte ranges.
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  createReadStream(path).pipe(res);
}

export async function startHarness(opts: { tabCaptureTitle?: string; stubApi?: boolean } = {}): Promise<Harness> {
  if (!existsSync(pathJoin(DIST, 'index.html'))) throw new Error('build first: npm run build --workspace=web');

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/') && !opts.stubApi) {
      const proxied = httpRequest(
        { ...API, path: url.pathname + url.search, method: req.method, headers: req.headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      proxied.on('error', () => res.writeHead(502).end());
      req.pipe(proxied);
      return;
    }
    if (url.pathname.startsWith('/__media/')) {
      const file = normalize(pathJoin(FIXTURES, url.pathname.slice('/__media/'.length)));
      if (!file.startsWith(FIXTURES) || !existsSync(file)) return void res.writeHead(404).end();
      return serveFile(file, req, res);
    }
    if (url.pathname === '/__doc') {
      // A stand-in "document" tab, so a tab share has something real to show.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DOC_PAGE);
      return;
    }
    let path = normalize(pathJoin(DIST, decodeURIComponent(url.pathname)));
    if (!path.startsWith(DIST)) return void res.writeHead(403).end();
    if (!existsSync(path) || statSync(path).isDirectory()) path = pathJoin(DIST, 'index.html');
    serveFile(path, req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    const up = netConnect(API.port, API.host, () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      up.write(`GET ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length > 0) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no address');
  const origin = `http://127.0.0.1:${addr.port}`;

  // Use a preinstalled Chromium when one is provided (CI images, sandboxes).
  const preinstalled = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    ...(existsSync(preinstalled) ? { executablePath: preinstalled } : {}),
    args: [
      '--no-sandbox',
      // The fake permission UI always answers a screen-capture request with the
      // synthetic screen, so leave it off when a real tab should be captured.
      ...(opts.tabCaptureTitle ? [] : ['--use-fake-ui-for-media-stream']),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${pathJoin(FIXTURES, 'camera.mjpeg')}`,
      '--autoplay-policy=no-user-gesture-required',
      opts.tabCaptureTitle
        ? `--auto-select-tab-capture-source-by-title=${opts.tabCaptureTitle}`
        : '--auto-select-desktop-capture-source=Entire screen',
      '--allow-http-screen-capture',
      '--enable-usermedia-screen-capturing',
    ],
  });

  return {
    origin,
    browser,
    async close() {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function freshSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export interface Client {
  page: Page;
  ctx: BrowserContext;
  errors: string[];
}

export async function newClient(
  h: Harness,
  opts: { viewport?: { width: number; height: number }; mobile?: boolean; scale?: number } = {},
): Promise<Client> {
  const ctx = await h.browser.newContext({
    viewport: opts.viewport ?? { width: 1360, height: 860 },
    deviceScaleFactor: opts.scale ?? 1,
    hasTouch: opts.mobile ?? false,
    isMobile: opts.mobile ?? false,
    permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'],
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { page, ctx, errors };
}

/** Open an invite link, fill in a name and enter the room. */
export async function joinRoom(
  h: Harness,
  secret: string,
  name: string,
  opts: Parameters<typeof newClient>[1] & { host?: string; camera?: boolean; mic?: boolean } = {},
): Promise<Client> {
  const c = await newClient(h, opts);
  await c.page.goto(`${h.origin}/#k=${secret}${opts.host ? `&h=${opts.host}` : ''}`, { waitUntil: 'load' });
  await c.page.getByLabel('Your name').fill(name);
  const micBtn = c.page.locator('.preview-controls .dock-btn').first();
  const camBtn = c.page.locator('.preview-controls .dock-btn').nth(1);
  if ((opts.mic ?? false) !== ((await micBtn.getAttribute('aria-pressed')) === 'true')) await micBtn.click();
  if ((opts.camera ?? false) !== ((await camBtn.getAttribute('aria-pressed')) === 'true')) await camBtn.click();
  await c.page.getByTestId('join').click();
  await c.page.locator('[data-testid="room"][data-status="connected"]').waitFor({ timeout: 30_000 });
  return c;
}

export const HOST_KEY = 'testhostkey_0123456789abcdefghij';

const DOC_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Launch plan</title>
<style>body{margin:0;font:16px/1.6 system-ui,sans-serif;background:#f6f4ef;color:#22201c}
main{max-width:760px;margin:0 auto;padding:56px 40px}h1{font-size:34px;letter-spacing:-.02em;margin:0 0 6px}
.sub{color:#7a756b;margin:0 0 32px}h2{font-size:18px;margin:28px 0 8px}li{margin:4px 0}
table{border-collapse:collapse;width:100%;margin-top:8px}td,th{border-bottom:1px solid #ddd8cc;padding:8px 4px;text-align:left}
th{font-size:13px;color:#7a756b;font-weight:600}</style></head><body><main>
<h1>Launch plan</h1><p class="sub">Draft 3 · shared for review</p>
<h2>Goals</h2><ul><li>Ship the redesigned room to everyone by the end of the month</li><li>Keep join time under three seconds</li><li>No regressions in call quality</li></ul>
<h2>Timeline</h2><table><tr><th>Week</th><th>Milestone</th><th>Owner</th></tr>
<tr><td>1</td><td>Design review and sign-off</td><td>Priya</td></tr><tr><td>2</td><td>Beta with two teams</td><td>Sam</td></tr>
<tr><td>3</td><td>Fix list and polish</td><td>Jonas</td></tr><tr><td>4</td><td>General availability</td><td>Everyone</td></tr></table>
<h2>Open questions</h2><ul><li>Do we need a migration note for existing links?</li><li>Who covers support during launch week?</li></ul>
</main></body></html>`;
