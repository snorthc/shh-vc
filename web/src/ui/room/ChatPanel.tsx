import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ArrowDown, CornerUpLeft, Lock, Pencil, RotateCw, SendHorizontal, Smile, SmilePlus, Trash2, X } from 'lucide-preact';
import { avatarColors, formatClock } from '../../app/util.ts';
import type { RoomSession } from '../../call/session.ts';
import {
  type ChatMessage,
  continuesGroup,
  EMOJI_GROUPS,
  isEmojiOnly,
  linkify,
  MAX_MESSAGE_LENGTH,
  QUICK_REACTIONS,
  sameDay,
} from '../../chat/store.ts';
import { Popover } from '../components/Popover.tsx';
import { Avatar, IconButton } from '../components/primitives.tsx';

function EmojiGrid(props: { onPick: (emoji: string) => void }) {
  return (
    <div class="emoji-grid">
      {EMOJI_GROUPS.map((g) => (
        <div key={g.label}>
          <div class="menu-label">{g.label}</div>
          <div class="emoji-row">
            {g.emoji.map((e) => (
              <button type="button" key={e} class="emoji-cell" aria-label={e} onClick={() => props.onPick(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MessageBody(props: { m: ChatMessage }) {
  const { m } = props;
  if (m.deleted) return <span class="msg-deleted">Message deleted</span>;
  return (
    <span class={`msg-text ${isEmojiOnly(m.text) ? 'jumbo' : ''}`}>
      {linkify(m.text).map((p, i) =>
        p.kind === 'link' ? (
          <a key={i} href={p.value} target="_blank" rel="noopener noreferrer nofollow">
            {p.value}
          </a>
        ) : (
          p.value
        ),
      )}
      {m.editedAt && <span class="msg-edited"> (edited)</span>}
    </span>
  );
}

function Message(props: {
  session: RoomSession;
  m: ChatMessage;
  grouped: boolean;
  parent?: ChatMessage;
  active: boolean;
  onActivate: (id: string | null) => void;
  onReply: (m: ChatMessage) => void;
  onJump: (id: string) => void;
}) {
  const { session, m, grouped } = props;
  const mine = m.from === session.identity;
  const name = session.nameOf(m.from);
  const who = session.participants.value.find((p) => p.identity === m.from);
  const hue = who?.hue ?? 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      const el = editRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  const saveEdit = () => {
    const text = draft.trim();
    if (text && text !== m.text) void session.editMessage(m.id, text);
    setEditing(false);
  };

  const reactions = Object.entries(m.reactions);

  return (
    <div
      class={`msg ${grouped ? 'grouped' : ''} ${props.active || picking ? 'active' : ''} ${m.status === 'failed' ? 'failed' : ''} ${m.status === 'sending' ? 'sending' : ''}`}
      data-id={m.id}
      data-testid="message"
      onClick={() => {
        if (matchMedia('(hover: none)').matches) props.onActivate(props.active ? null : m.id);
      }}
    >
      {props.parent !== undefined && (
        <button type="button" class="msg-reply" onClick={(e) => { e.stopPropagation(); props.onJump(props.parent!.id); }}>
          <span class="reply-spine" aria-hidden="true" />
          <span class="reply-name" style={{ color: avatarColors(session.participants.value.find((p) => p.identity === props.parent!.from)?.hue ?? 0).fg }}>
            {session.nameOf(props.parent.from)}
          </span>
          <span class="reply-text">{props.parent.deleted ? 'Message deleted' : props.parent.text}</span>
        </button>
      )}

      <div class="msg-gutter">
        {grouped ? (
          <time class="msg-hover-time">{formatClock(m.ts).replace(/\s?[AP]M$/i, '')}</time>
        ) : (
          <Avatar name={name} hue={hue} size={36} />
        )}
      </div>

      <div class="msg-main">
        {!grouped && (
          <div class="msg-head">
            <span class="msg-name" style={{ color: avatarColors(hue).fg }}>
              {name}
            </span>
            <time class="msg-time" dateTime={new Date(m.ts).toISOString()}>
              {formatClock(m.ts)}
            </time>
          </div>
        )}

        {editing ? (
          <div class="msg-edit">
            <textarea
              ref={editRef}
              value={draft}
              maxLength={MAX_MESSAGE_LENGTH}
              rows={Math.min(6, draft.split('\n').length)}
              aria-label="Edit message"
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setEditing(false);
                } else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
              }}
            />
            <span class="hint">
              Escape to <button type="button" class="link" onClick={() => setEditing(false)}>cancel</button> · Enter to{' '}
              <button type="button" class="link" onClick={saveEdit}>save</button>
            </span>
          </div>
        ) : (
          <MessageBody m={m} />
        )}

        {m.status === 'failed' && (
          <div class="msg-failed">
            Not sent.
            <button type="button" class="link" onClick={() => void session.retryMessage(m.id)}>
              <RotateCw /> Try again
            </button>
          </div>
        )}

        {reactions.length > 0 && (
          <div class="msg-reactions">
            {reactions.map(([emoji, ids]) => (
              <button
                type="button"
                key={emoji}
                class={`reaction ${ids.includes(session.identity) ? 'mine' : ''}`}
                aria-pressed={ids.includes(session.identity)}
                title={ids.map((id) => session.nameOf(id)).join(', ')}
                onClick={(e) => { e.stopPropagation(); session.toggleReaction(m.id, emoji); }}
                data-testid="reaction"
              >
                <span>{emoji}</span>
                <span class="mono">{ids.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!m.deleted && !editing && (
        <div class="msg-actions" onClick={(e) => e.stopPropagation()}>
          <IconButton label="Add reaction" btnRef={pickRef} onClick={() => setPicking(!picking)} data-testid="msg-react">
            <SmilePlus />
          </IconButton>
          <IconButton label="Reply" onClick={() => props.onReply(m)} data-testid="msg-reply">
            <CornerUpLeft />
          </IconButton>
          {mine && (
            <IconButton label="Edit" onClick={() => { setDraft(m.text); setEditing(true); }} data-testid="msg-edit">
              <Pencil />
            </IconButton>
          )}
          {mine && (
            <IconButton
              label={confirmDelete ? 'Click again to delete' : 'Delete'}
              class={confirmDelete ? 'confirm' : ''}
              onClick={() => (confirmDelete ? void session.deleteMessage(m.id) : setConfirmDelete(true))}
              data-testid="msg-delete"
            >
              <Trash2 />
            </IconButton>
          )}
        </div>
      )}
      <Popover open={picking} onClose={() => setPicking(false)} anchor={pickRef} align="end" label="Add reaction" class="emoji-pop">
        <div class="emoji-row quick">
          {QUICK_REACTIONS.map((e) => (
            <button type="button" key={e} class="emoji-cell" aria-label={`React ${e}`} onClick={() => { session.toggleReaction(m.id, e); setPicking(false); }}>
              {e}
            </button>
          ))}
        </div>
        <div class="menu-sep" />
        <EmojiGrid onPick={(e) => { session.toggleReaction(m.id, e); setPicking(false); }} />
      </Popover>
    </div>
  );
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  if (sameDay(ts, Date.now())) return 'Today';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function ChatPanel(props: { session: RoomSession }) {
  const { session } = props;
  const messages = session.messages.value;
  const typing = session.typing.value;
  const online = session.status.value === 'connected';
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);
  const [sendPulse, setSendPulse] = useState(0);
  const stick = useRef(true);
  const seen = useRef(messages.length);
  /** Where the "new" divider goes: the first message that arrived while chat was closed. */
  const [newFrom] = useState<string | undefined>(() => {
    const n = session.unread.peek();
    return n > 0 ? messages[messages.length - n]?.id : undefined;
  });

  // Focus on commit, so a letter typed right after opening lands in the box.
  useLayoutEffect(() => {
    session.setChatVisible(true);
    if (!matchMedia('(hover: none)').matches) inputRef.current?.focus();
    return () => session.setChatVisible(false);
  }, []);

  // Stay pinned to the latest message unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const added = messages.length - seen.current;
    seen.current = messages.length;
    const last = messages[messages.length - 1];
    if (stick.current || (added > 0 && last?.from === session.identity)) {
      el.scrollTop = el.scrollHeight;
      setMissed(0);
    } else if (added > 0) {
      setMissed((n) => n + added);
    }
  }, [messages, typing.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = near;
    setAtBottom(near);
    if (near) setMissed(0);
  };

  const toLatest = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  };
  useLayoutEffect(autosize, [text]);

  const send = () => {
    const value = text.trim();
    if (!value || !online) return;
    void session.sendMessage(value, replyTo?.id);
    setText('');
    setReplyTo(null);
    setSendPulse((n) => n + 1);
    stick.current = true;
    inputRef.current?.focus();
  };

  const jump = (id: string) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    const at = el?.selectionStart ?? text.length;
    setText(text.slice(0, at) + emoji + text.slice(el?.selectionEnd ?? at));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + emoji.length, at + emoji.length);
    });
  };

  const typingNames = typing.map((id) => session.nameOf(id));
  const typingText =
    typingNames.length === 0
      ? ''
      : typingNames.length === 1
        ? `${typingNames[0]} is typing`
        : typingNames.length === 2
          ? `${typingNames[0]} and ${typingNames[1]} are typing`
          : 'Several people are typing';
  const remaining = MAX_MESSAGE_LENGTH - text.length;

  return (
    <div class="chat" data-testid="chat">
      <div class="chat-list" ref={listRef} onScroll={onScroll} role="log" aria-label="Messages" aria-live="polite">
        {messages.length === 0 ? (
          <div class="chat-empty">
            <Lock />
            <strong>No messages yet</strong>
            <p>
              Messages are end-to-end encrypted and are not stored anywhere. People who join later
              will not see what was said before they arrived.
            </p>
          </div>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || !sameDay(prev.ts, m.ts);
            const isNew = m.id === newFrom;
            return (
              <div key={m.id}>
                {newDay && (
                  <div class="chat-divider">
                    <span>{dayLabel(m.ts)}</span>
                  </div>
                )}
                {isNew && (
                  <div class="chat-divider new">
                    <span>New</span>
                  </div>
                )}
                <Message
                  session={session}
                  m={m}
                  grouped={!newDay && !isNew && continuesGroup(prev, m)}
                  parent={m.replyTo ? messages.find((x) => x.id === m.replyTo) : undefined}
                  active={active === m.id}
                  onActivate={setActive}
                  onReply={(msg) => { setReplyTo(msg); setActive(null); inputRef.current?.focus(); }}
                  onJump={jump}
                />
              </div>
            );
          })
        )}
      </div>

      {!atBottom && (
        <button type="button" class="chat-latest" onClick={toLatest}>
          <ArrowDown />
          {missed > 0 ? `${missed} new message${missed === 1 ? '' : 's'}` : 'Jump to latest'}
        </button>
      )}

      <div class="chat-foot">
        <div class="typing" aria-live="polite" data-testid="typing">
          {typingText && (
            <>
              <span class="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {typingText}
            </>
          )}
        </div>

        <div class={`composer ${online ? '' : 'disabled'}`}>
          {replyTo && (
            <div class="composer-reply">
              <span>
                Replying to <strong>{session.nameOf(replyTo.from)}</strong>
              </span>
              <IconButton label="Cancel reply" onClick={() => setReplyTo(null)}>
                <X />
              </IconButton>
            </div>
          )}
          <div class="composer-row">
            <textarea
              ref={inputRef}
              rows={1}
              value={text}
              maxLength={MAX_MESSAGE_LENGTH}
              disabled={!online}
              placeholder={online ? 'Message the room' : 'Reconnecting — messages are paused'}
              aria-label="Message the room"
              enterkeyhint="send"
              data-testid="composer"
              onInput={(e) => {
                setText((e.target as HTMLTextAreaElement).value);
                session.notifyTyping();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  send();
                } else if (e.key === 'Escape' && replyTo) {
                  e.stopPropagation();
                  setReplyTo(null);
                }
              }}
            />
            {remaining < 200 && <span class={`composer-count mono ${remaining < 20 ? 'low' : ''}`}>{remaining}</span>}
            <IconButton label="Emoji" btnRef={emojiRef} onClick={() => setEmojiOpen(!emojiOpen)} disabled={!online}>
              <Smile />
            </IconButton>
            <button
              type="button"
              key={sendPulse}
              class={`send ${sendPulse ? 'sent' : ''}`}
              aria-label="Send message"
              disabled={!text.trim() || !online}
              onClick={send}
              data-testid="send"
            >
              <SendHorizontal />
            </button>
          </div>
        </div>
      </div>

      <Popover open={emojiOpen} onClose={() => setEmojiOpen(false)} anchor={emojiRef} align="end" label="Emoji" class="emoji-pop">
        <EmojiGrid onPick={insertEmoji} />
      </Popover>
    </div>
  );
}
