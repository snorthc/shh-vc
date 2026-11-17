import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // The room secret lives in the URL fragment and must never be sent to a server.
  plugins: [preact()],
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
