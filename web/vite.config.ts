import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** One self-contained HTML file that runs when opened from disk: no host at all. */
const SINGLE = process.env.VITE_SINGLEFILE === '1';

/**
 * A static host such as GitHub Pages cannot send security headers, so the
 * serverless build carries its policy in the page: scripts, styles and fonts
 * from this origin only; network access limited to WebSocket relays; video
 * from https for watch-together links.
 */
const pagePolicy = {
  name: 'shh-page-policy',
  transformIndexHtml(html: string) {
    // A file opened from disk has no origin for 'self' to mean anything.
    if (process.env.VITE_TRANSPORT !== 'direct' || SINGLE) return html;
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "media-src 'self' blob: https:",
      "connect-src 'self' wss: ws://127.0.0.1:*",
      "worker-src 'self' blob:",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    return html.replace('<meta name="referrer"', `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer"`);
  },
};

export default defineConfig({
  // The room secret lives in the URL fragment and must never be sent to a server.
  plugins: [preact(), pagePolicy, ...(SINGLE ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
  build: SINGLE
    ? { target: 'es2022', sourcemap: false, assetsInlineLimit: 100_000_000, cssCodeSplit: false }
    : { target: 'es2022', sourcemap: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true },
    },
    headers: { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
  },
} as never);
