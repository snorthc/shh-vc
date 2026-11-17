import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

/**
 * A static host such as GitHub Pages cannot send security headers, so the
 * serverless build carries its policy in the page: scripts, styles and fonts
 * from this origin only; network access limited to WebSocket relays; video
 * from https for watch-together links.
 */
const pagePolicy = {
  name: 'shh-page-policy',
  transformIndexHtml(html: string) {
    if (process.env.VITE_TRANSPORT !== 'direct') return html;
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
  plugins: [preact(), pagePolicy],
  build: { target: 'es2022', sourcemap: true },
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
