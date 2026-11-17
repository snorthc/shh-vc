/**
 * How rooms are carried.
 *
 *   direct — browsers connect straight to each other and find one another via
 *            public relays. No server to run, nothing to pay for. People in a
 *            room can see each other's IP addresses.
 *   server — media goes through a self-hosted LiveKit relay, which hides
 *            participants' addresses from each other and enables host controls.
 *
 * Chosen at build time: VITE_TRANSPORT=direct | server.
 */
export const DIRECT = import.meta.env.VITE_TRANSPORT === 'direct';

/** Override the discovery relays, e.g. for tests against a local relay. */
export const RELAY_URLS: string[] = String(import.meta.env.VITE_RELAYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const APP_NAME = 'Shh VC';
