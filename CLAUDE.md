# Shh VC — invariants

Read this before changing anything. If a change breaks one of these it is a
bug, even if every test passes.

## The room secret

1. The 32-byte room secret lives in the **URL fragment** and in memory. Never
   in a path, query, header, body, `localStorage`, `sessionStorage`, cookie,
   log line or error report. The host key rides beside it in the creator's
   address bar and follows the same rule.
2. Only two things derived from it leave the browser: `roomId` (a truncated
   SHA-256) and key-agreement messages (MAC'd or AEAD-sealed).
3. The **invite link never contains the host key**.
4. No analytics, error reporting, session replay, or third-party script, style
   or font. Fonts are bundled. `tests/e2e/privacy.spec.ts` asserts all of this.
5. `localStorage` holds preferences only (`app/settings.ts`): a display name,
   device ids, volumes, presets. Nothing secret, no chat.

## Key agreement

6. A participant enters the key group only after their announcement's HMAC
   verifies under a key derived from the room secret. There is no fallback
   that accepts an unverified key.
7. Media keys change on every membership change: **leave → fresh random key**,
   **join → one-way ratchet**. Old keyring slots stay populated on purpose
   (Chrome cannot force a keyframe after a rekey).
8. Key agreement travels over the relay (`server/src/signal.ts`), **never over
   LiveKit's data channel** — that channel is encrypted with the very keys
   being agreed. The relay never parses payloads, and only identities that
   were issued a token may connect to it.
9. `reconcile()` keeps re-announcing and re-sending keys until everyone is
   keyed. Do not remove it: one dropped message otherwise strands a
   participant.

## The encrypted app channel

10. Chat, reactions, presence, watch-together state and shared play/pause go
    over LiveKit's data channel, which is E2EE with the sender's own key. The
    sender of a message is therefore authenticated by the fact it decrypted.
11. Only an author can edit or delete their message (`applyChat` enforces it).
    Chat text is rendered as text nodes and links — never as HTML.
12. Nothing is stored server-side. A late joiner does not see earlier chat,
    and the UI says so.

## Screen sharing

13. **The preview is local.** Between `choose()` and `confirm()` the capture is
    attached to no peer connection. Cancelling stops the capture tracks. A test
    asserts the other participant has no screen-share publication during the
    preview.
14. The browser's own picker cannot be skipped or replaced. Never imply
    otherwise in copy.
15. Quality settings are requests, applied through real APIs
    (`applyConstraints`, `RTCRtpSender.setParameters`). The UI must show what
    is actually captured and sent when it differs.
16. Diagnostics show values from `getStats()`. A value the browser does not
    report is shown as "—". Nothing is estimated or invented.
17. Do not offer a control the browser cannot honour (per-application audio,
    screen capture on phones). Explain the limit instead.

## Watching together

18. Shh VC controls playback itself for a video **link** (each client plays
    it) and a **file** (one device plays and streams it). For **own-account**
    watching (Netflix and the like) it keeps a shared clock; a linked tab
    follows it through the bookmarklet. Everyone's pause, play and skip work
    unless the host's rule (36) says otherwise.
19. For a shared tab, only the sharer can press pause. Viewers get "Ask to
    pause", which is a request and is labelled as one.
20. Never bypass DRM or a site's protections. The bookmarklet only presses the
    site's own play, pause and seek controls and reads the time, episode id and
    title. It never captures, copies or sends the picture or sound, and never
    carries the room secret (the link window is on this origin, found by
    BroadcastChannel). On Netflix it uses Netflix's player controls, never the
    video element's currentTime.

## Mute and deafen

21. They are independent. Deafen silences incoming audio and must not touch
    the microphone. Each has its own control, its own state, and its own icon
    in other people's view.

## Host controls

22. Enforced by the server and LiveKit, not by client cooperation. The host key
    authorises moderation calls only; it decrypts nothing.
23. The host badge comes from server-attested participant metadata.

## Honesty

24. The landing page must keep saying that **the server sees IP addresses**
    and that **anyone with the link can join**. A test asserts both.
25. No fake participants, messages, statistics or states — including in
    marketing imagery. The hero illustration is a drawing and is hidden from
    assistive technology.

## Serverless mode (`VITE_TRANSPORT=direct`)

27. Browsers connect directly. **People in a room can see each other's IP
    address**, and the UI must say so on the landing page and before joining.
    Never reuse the relay build's "nobody sees your IP" copy here.
28. Discovery goes through public relays under a key derived from the room
    secret. Nothing sent to a relay may contain the secret, the room id, a
    name, a message or readable SDP. `tests/e2e/direct.spec.ts` checks this.
29. There is no server, so there is **no moderation**. Do not render lock,
    remove or mute-for-everyone in this mode. The playback rule (36) is the
    only host power, because it needs no server.
30. If no relay is reachable the room must say that nobody can find it.

## Microphone and voice

31. The microphone always goes through `audio/mic.ts`. Its outgoing track
    never changes during a call; switching suppression or devices rewires the
    graph instead of renegotiating.
32. Never stack two noise suppressors. The AI filters run with the browser's
    own `noiseSuppression` off. Stacking them is a known cause of robotic,
    watery voices.
33. When re-capturing the microphone, stop the old capture first: Chrome
    otherwise returns the same device with the old processing settings.
34. Noise-suppression models are bundled and served from this site. Never load
    one from a third-party CDN (that is why DeepFilterNet is not included).
    The page CSP allows `'wasm-unsafe-eval'` for them and nothing more.
35. Keep RED first in the audio codec order, Opus FEC on and DTX off
    (`audio/tuning.ts`). `tests/audio.test.ts` and the redundant-audio browser
    test guard this.

## Cost

26. Everything must run on free infrastructure. No paid API, SDK, font,
    library or service. Relay-only media means bandwidth is the budget: the
    six-person cap is enforced server-side.

## Who controls playback

36. The room creator's host key (address bar only, never storage, never the
    invite) derives an Ed25519 key. Its **public** half rides in the invite as
    `&p=`. The host signs the rule (`policy`) and their own playback commands;
    every device drops commands the rule forbids and checks before sending
    its own. Levels: everyone / everyone pauses, host does the rest / host
    only. Others get **Ask to pause**.
37. The rule lapses to "everyone" 30 seconds after the last signed message
    from the host (`HOST_GRACE_MS`), so a departed host never freezes a room.
38. Enforcement is per device: a modified client can only misbehave on its
    own player. Never describe it as stronger than that.

