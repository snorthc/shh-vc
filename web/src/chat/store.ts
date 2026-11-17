/**
 * Chat model. Pure state transitions, so they can be tested without a room.
 *
 * Messages travel over LiveKit's data channel, which is end-to-end encrypted
 * with the sender's own key — so the sender of a message is authenticated by
 * the fact that it decrypted. Nothing is stored on a server: a participant
 * sees messages sent while they were in the room.
 */

export const MAX_MESSAGE_LENGTH = 2000;
/** Consecutive messages by one author within this window render as a group. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  ts: number;
  editedAt?: number;
  deleted?: boolean;
  replyTo?: string;
  /** emoji -> identities */
  reactions: Record<string, string[]>;
  /** Local-only delivery state for our own messages. */
  status?: 'sending' | 'failed';
}

export type ChatWire =
  | { t: 'msg'; id: string; text: string; ts: number; replyTo?: string }
  | { t: 'edit'; id: string; text: string }
  | { t: 'del'; id: string }
  | { t: 'react'; id: string; emoji: string; on: boolean };

export function newMessageId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

export function sanitizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').slice(0, MAX_MESSAGE_LENGTH).trim();
}

/** Apply a wire event from `from`. Returns the same array if nothing changed. */
export function applyChat(messages: ChatMessage[], from: string, wire: ChatWire): ChatMessage[] {
  switch (wire.t) {
    case 'msg': {
      const text = sanitizeText(wire.text);
      if (!text || messages.some((m) => m.id === wire.id)) return messages;
      const replyTo =
        wire.replyTo && messages.some((m) => m.id === wire.replyTo) ? wire.replyTo : undefined;
      return [...messages, { id: wire.id, from, text, ts: wire.ts, replyTo, reactions: {} }];
    }
    case 'edit': {
      const text = sanitizeText(wire.text);
      if (!text) return messages;
      // Only the author may edit. A forged edit from someone else is ignored.
      return mapOwn(messages, wire.id, from, (m) =>
        m.deleted ? m : { ...m, text, editedAt: Date.now() },
      );
    }
    case 'del':
      return mapOwn(messages, wire.id, from, (m) => ({
        ...m,
        deleted: true,
        text: '',
        reactions: {},
      }));
    case 'react': {
      if (!isSingleEmoji(wire.emoji)) return messages;
      let changed = false;
      const next = messages.map((m) => {
        if (m.id !== wire.id || m.deleted) return m;
        const current = m.reactions[wire.emoji] ?? [];
        const has = current.includes(from);
        if (wire.on === has) return m;
        changed = true;
        const list = wire.on ? [...current, from] : current.filter((id) => id !== from);
        const reactions = { ...m.reactions };
        if (list.length === 0) delete reactions[wire.emoji];
        else reactions[wire.emoji] = list;
        return { ...m, reactions };
      });
      return changed ? next : messages;
    }
  }
}

function mapOwn(
  messages: ChatMessage[],
  id: string,
  from: string,
  fn: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.id !== id || m.from !== from) return m;
    changed = true;
    return fn(m);
  });
  return changed ? next : messages;
}

export function setStatus(
  messages: ChatMessage[],
  id: string,
  status: ChatMessage['status'],
): ChatMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, status } : m));
}

/** True when `m` should render without its own avatar and header. */
export function continuesGroup(prev: ChatMessage | undefined, m: ChatMessage): boolean {
  if (!prev) return false;
  if (prev.from !== m.from) return false;
  if (m.replyTo) return false;
  if (prev.deleted !== m.deleted && (prev.deleted || m.deleted)) return false;
  return m.ts - prev.ts < GROUP_WINDOW_MS && sameDay(prev.ts, m.ts);
}

export function sameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u;

export function isSingleEmoji(s: string): boolean {
  return s.length <= 16 && EMOJI_RE.test(s);
}

/** Messages made only of a few emoji are shown larger. */
export function isEmojiOnly(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (!compact || compact.length > 40) return false;
  return /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)+$/u.test(
    compact,
  );
}

export type TextPart = { kind: 'text'; value: string } | { kind: 'link'; value: string };

/** Split text into plain runs and http(s) links. Never produces HTML. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    let url = match[0];
    const start = match.index ?? 0;
    // Trailing punctuation belongs to the sentence, not the link.
    const trimmed = url.replace(/[),.;:!?]+$/, '');
    url = trimmed;
    if (start > last) parts.push({ kind: 'text', value: text.slice(last, start) });
    parts.push({ kind: 'link', value: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

export const EMOJI_GROUPS: { label: string; emoji: string[] }[] = [
  {
    label: 'Smileys',
    emoji: ['😀', '😄', '😁', '😂', '🤣', '😊', '🙂', '😉', '😍', '😘', '😎', '🤔', '😐', '😴', '😮', '😢', '😭', '😡', '🥳', '🤯', '😅', '🙃', '😬', '🤝'],
  },
  {
    label: 'Gestures',
    emoji: ['👍', '👎', '👏', '🙌', '🙏', '👋', '✌️', '🤞', '💪', '👀', '🫡', '🤷'],
  },
  {
    label: 'Symbols',
    emoji: ['❤️', '🔥', '✨', '🎉', '💯', '✅', '❌', '⭐', '💡', '⚡', '🎬', '🍿'],
  },
];
