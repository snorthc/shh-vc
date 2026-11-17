/** Configuration, all from the environment. Nothing is written to disk, ever. */
export interface Config {
  port: number;
  host: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  /** Internal URL the server uses to talk to LiveKit, e.g. http://127.0.0.1:7880 */
  livekitHostUrl: string;
  /** Public wss:// URL handed to browsers. */
  publicWsUrl: string;
  maxParticipants: number;
  /** Seconds a room survives with nobody in it before LiveKit deletes it. */
  emptyTimeout: number;
  /** Token lifetime. Also the effective maximum call length. */
  tokenTtlSeconds: number;
  /** Token requests allowed per client per window. */
  rateLimit: number;
  rateWindowMs: number;
  /** Refuse to mint tokens for new rooms beyond this many concurrent rooms. */
  maxConcurrentRooms: number;
  allowedOrigins: string[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

export function loadConfig(): Config {
  return {
    port: num('PORT', 8787),
    host: process.env.HOST ?? '127.0.0.1',
    livekitApiKey: required('LIVEKIT_API_KEY'),
    livekitApiSecret: required('LIVEKIT_API_SECRET'),
    livekitHostUrl: process.env.LIVEKIT_HOST_URL ?? 'http://127.0.0.1:7880',
    publicWsUrl: required('PUBLIC_WS_URL'),
    maxParticipants: num('MAX_PARTICIPANTS', 6),
    emptyTimeout: num('EMPTY_TIMEOUT', 120),
    tokenTtlSeconds: num('TOKEN_TTL_SECONDS', 4 * 60 * 60),
    rateLimit: num('RATE_LIMIT', 20),
    rateWindowMs: num('RATE_WINDOW_MS', 60_000),
    maxConcurrentRooms: num('MAX_CONCURRENT_ROOMS', 50),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
