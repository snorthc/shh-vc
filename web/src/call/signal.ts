/**
 * Client side of the key-agreement relay.
 *
 * This is a separate channel from LiveKit's data channel on purpose: LiveKit
 * encrypts data messages with the sender's media key, so a key could never be
 * delivered over it. The relay broadcasts opaque bytes and cannot read them.
 *
 * Messages are best-effort. The caller is expected to re-send until peers are
 * keyed (see VeilCall.reconcile), so a drop during connection setup heals
 * instead of leaving a participant permanently unable to decrypt.
 */
export interface SignalOptions {
  /** e.g. https://talk.example.com/api/signal — scheme is upgraded to ws/wss. */
  endpoint: string;
  roomId: string;
  identity: string;
  onMessage: (from: string, payload: Uint8Array) => void;
  onOpenChange?: (open: boolean) => void;
}

const MAX_BACKOFF_MS = 10_000;

export class SignalChannel {
  private socket: WebSocket | undefined;
  private queue: string[] = [];
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: SignalOptions) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private url(): string {
    const u = new URL(this.opts.endpoint, location.href);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    // Only the room id (a hash) and a random identity. Never the secret.
    u.searchParams.set('room', this.opts.roomId);
    u.searchParams.set('id', this.opts.identity);
    return u.toString();
  }

  /** Resolves when the channel is first open, or rejects if it cannot open. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const open = () => resolve();
      const fail = (reason: string) => reject(new Error(reason));
      this.openSocket(open, fail);
    });
  }

  private openSocket(onFirstOpen?: () => void, onFirstFail?: (reason: string) => void): void {
    if (this.closed) return;
    let settled = false;
    const socket = new WebSocket(this.url());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.opts.onOpenChange?.(true);
      for (const pending of this.queue.splice(0)) socket.send(pending);
      if (!settled) {
        settled = true;
        onFirstOpen?.();
      }
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let framed: { from?: unknown; payload?: unknown };
      try {
        framed = JSON.parse(event.data) as { from?: unknown; payload?: unknown };
      } catch {
        return;
      }
      if (typeof framed.from !== 'string' || typeof framed.payload !== 'string') return;
      this.opts.onMessage(framed.from, new TextEncoder().encode(framed.payload));
    });

    const retry = () => {
      this.opts.onOpenChange?.(false);
      if (this.closed) return;
      if (!settled) {
        settled = true;
        onFirstFail?.('could not open the key-agreement channel');
        return;
      }
      const delay = Math.min(MAX_BACKOFF_MS, 250 * 2 ** this.attempt++);
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    };

    socket.addEventListener('close', retry);
    socket.addEventListener('error', retry);
  }

  /** Broadcast to the room. Queued if the socket is not open yet. */
  send(payload: Uint8Array): void {
    if (this.closed) return;
    const text = new TextDecoder().decode(payload);
    if (this.isOpen) this.socket!.send(text);
    else if (this.queue.length < 64) this.queue.push(text);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
    this.queue = [];
  }
}
