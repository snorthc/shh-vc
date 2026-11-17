/**
 * A minimal Nostr relay (the REQ / EVENT / CLOSE subset of NIP-01), for tests.
 *
 * In production the serverless build discovers peers through public Nostr
 * relays. Tests cannot depend on the public internet, so they run the same
 * protocol against this local stand-in. It verifies nothing and stores a few
 * recent events in memory.
 */
import { type WebSocket, WebSocketServer } from 'ws';

interface NostrEvent {
  id: string;
  kind: number;
  created_at: number;
  tags: string[][];
}
type Filter = Record<string, unknown>;

function matches(filter: Filter, ev: NostrEvent): boolean {
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(ev.kind)) return false;
  if (typeof filter.since === 'number' && ev.created_at < filter.since) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const name = key.slice(1);
    if (!ev.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}

export function startRelay(port: number): { url: string; close(): Promise<void>; stats: { events: number } } {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  const subs = new Map<WebSocket, Map<string, Filter[]>>();
  const recent: NostrEvent[] = [];
  const stats = { events: 0 };

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT') {
        const ev = msg[1] as NostrEvent;
        stats.events++;
        recent.push(ev);
        if (recent.length > 400) recent.shift();
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
        for (const [client, clientSubs] of subs) {
          for (const [subId, filters] of clientSubs) {
            if (filters.some((f) => matches(f, ev))) client.send(JSON.stringify(['EVENT', subId, ev]));
          }
        }
      } else if (msg[0] === 'REQ') {
        const subId = String(msg[1]);
        const filters = msg.slice(2) as Filter[];
        subs.get(ws)?.set(subId, filters);
        for (const ev of recent) {
          if (filters.some((f) => matches(f, ev))) ws.send(JSON.stringify(['EVENT', subId, ev]));
        }
        ws.send(JSON.stringify(['EOSE', subId]));
      } else if (msg[0] === 'CLOSE') {
        subs.get(ws)?.delete(String(msg[1]));
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    stats,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}
