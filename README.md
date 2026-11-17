# Shh VC

Private rooms for talking, sharing your screen and watching together. Up to
six people, no account: start a room, send the link.

Everything is end-to-end encrypted, and everything runs for free.

## Two ways to run it

| | **Serverless** (what is hosted) | **Self-hosted relay** |
|---|---|---|
| What you need | A static site. Nothing else. | A server running LiveKit and the token service |
| How browsers connect | Directly to each other | Through your relay |
| How they find each other | Public Nostr relays, via [Trystero](https://github.com/dmotz/trystero). No account. | Your server |
| Can people in a room see each other's IP? | **Yes** | No |
| Host controls (remove, lock, mute for all) | No — nothing can enforce them | Yes |
| Works behind every network | Most. Two people both behind strict NATs may fail to connect | Yes (TURN) |
| Cost | Free, no accounts | Free on Oracle's free tier, which needs an account and a card |

Build the serverless site with `npm run build:direct --workspace=web`; the
output in `web/dist-pages` can be dropped on any static host. Everything else
in this README applies to both unless it says otherwise.

Screens are in [`docs/screens`](docs/screens).

## What it does

**Rooms.** Camera, microphone, speaking indicators, connection states, and a
verification number to confirm nobody has been swapped into the encrypted
group.

**Clear voice, even on bad Wi-Fi.** Every audio packet also carries the
previous 20 ms of sound (RED), Opus runs at 48 kbps with error correction,
and audio gets priority over video when the connection is under pressure. In a
measured call with 12% packet loss, the share of audio the receiver had to
invent dropped from 3.7% to under 0.6%. `tests/audio/measure.ts` reproduces it.

**Noise suppression you choose.** Off, Standard (the browser's built-in
filter), AI · Light (RNNoise) or AI · Strong (GTCRN, a 2024 neural model of the
same kind Krisp uses). The AI filters run in your browser; the models are
served from the site itself and your audio never leaves your device to be
cleaned. On a fan-and-keyboard recording, AI · Strong lowered the background
by 33 dB. Switch any time from the arrow beside the microphone button, and try
it before joining with *Hear yourself*.

**Mute and deafen, separately.** Mute stops others hearing you. Deafen stops
you hearing others. Neither touches the other, and other people see each
state on your tile.

**Screen sharing with a preview.** Pick a screen, window or tab in the
browser's picker and Shh VC shows it to you first. Nothing is sent until you
press *Start sharing*; cancelling stops the capture. Then:

- presets — Balanced, Text & code, Presentation, Cinema, Gaming & motion, Low
  bandwidth, Custom (480p–4K, 15–60 fps, bitrate levels or a custom ceiling) —
  applied to the real capture and the real `RTCRtpSender`, live
- a note when the source cannot deliver what was asked ("the source is 900p,
  so 1080p cannot be reached")
- diagnostics from `getStats()`: resolution, frame rate, bitrate, codec, loss,
  round trip, dropped frames, what is limiting the encoder
- change source without stopping, fullscreen, and four layouts: Presentation,
  Cinema, Theatre, Social

**Watching together**, three ways, in plain terms:

| | Who can pause? |
|---|---|
| A video file on your device — it plays on your device and is streamed to the room; nothing is uploaded | **Everyone** |
| A link to an MP4/WebM — each browser loads it, Shh VC keeps everyone at the same moment | **Everyone** |
| Netflix, YouTube, any site — share the tab with sound | Only the sharer. Everyone else gets **Ask to pause**, which pings them |

A web page cannot press buttons inside another site's player, so the third
row is the honest limit. Shh VC does not bypass DRM.

**Chat**, in the style people know from Discord: avatar gutter, grouped
messages, replies, reactions, edit and delete of your own messages, typing
indicators, unread markers, Enter to send and Shift+Enter for a new line.
Messages are encrypted and never stored; someone who joins later does not see
what was said before.

**Host controls**, for whoever created the room: mute someone for everyone,
remove them, lock the room. Enforced by the server.

**Sounds.** Short synthesised tones for joining, messages, mute, deafen and
sharing — no audio files. Volume and an off switch in Settings.

**Phones.** A bottom bar within thumb's reach, chat and settings as sheets you
can drag away, tiles that fill a portrait screen.

## What it hides, and what it does not

| | |
|---|---|
| ✅ Other participants never learn your IP *(self-hosted relay only)* | All media is relayed. In the serverless build browsers connect directly, so people in a room **can** see each other's IP |
| ✅ The server cannot read calls, shares or chat | Encrypted per sender before leaving the browser |
| ✅ The server cannot join your call | Joining the key group needs a MAC under a key derived from the link |
| ✅ Nothing is kept | No database, no logs of addresses, no accounts |
| ❌ Infrastructure sees your IP | Your relay server, or in the serverless build the public Nostr relays and STUN servers. None of them can read the room. Use a VPN if that matters |
| ❌ Anyone with the link can join | Until the host locks the room |
| ❌ No protection after a device is compromised | Keys rotate on join and leave; that does not heal a compromised device |
| ❌ Not audited | Nobody outside this repo has reviewed the cryptography |

## Running it

Needs Node 22+ and Docker.

```bash
npm install
```

```bash
./dev-stack.sh
```

```bash
npm run dev
```

Open http://localhost:5173. `dev-stack.sh` starts LiveKit in Docker and the
token/relay service; the dev server proxies `/api` to it.

## Tests

```bash
npm test
```

74 unit tests: the cryptography (key derivation, announcement MACs, envelope
binding, rotation and ratchet, low-order X25519 points) and the app logic
(share presets and bitrate maths, WebRTC stats parsing, sync correction, the
chat model, the tile grid).

```bash
npx playwright install chromium
```

```bash
npm run test:e2e
```

33 browser tests against the real stack, with several Chromium instances in
one room:

- video decrypts in both directions; everyone agrees on the safety number
- mute and deafen are independent, and visible to others
- chat: delivery, grouping, reply, reactions, edit, delete, typing, unread;
  no raw HTML; late joiners see nothing earlier
- **the share preview sends nothing**: the other participant has no
  screen-share publication until Start sharing, and cancel stops the capture
- presets change the real sender's bitrate and frame rate; diagnostics show
  measured values
- watch together stays in step across play, pause, seek and a late joiner
- a file played from one device can be paused and skipped by someone else
- host mute, remove and lock; a forged moderation call is refused
- sounds obey their settings; microphone processing reaches the live track
- phones (390×844 and 360×640): no sideways scroll, nothing clipped, touch
  targets ≥ 44 px, text ≥ 11 px, 16 px inputs, sheets that drag to dismiss
- the room secret appears in no request, and nothing loads from a third party

```bash
npm run test:e2e:direct --workspace=web
```

The same browser tests against the serverless build, with a local Nostr relay
standing in for the public ones: 27 pass, 8 server-only tests are skipped. One
of them captures every frame sent to the relay and checks it contains no room
secret, room id, name, message or readable connection data.

```bash
npm run screens
```

Regenerates the screenshots.

## Deploying for free

| Layer | Where | Cost |
|---|---|---|
| Frontend | Cloudflare Pages, or the same box behind Caddy | free |
| Media relay + TURN | LiveKit on Oracle Cloud Always Free (4 ARM cores, 24 GB, **10 TB egress/month**) | free |
| Token + key relay | Node, same box | free |
| TLS | Caddy + Let's Encrypt | free |

`deploy/oracle-setup.sh` provisions the box. **It has never been run** — read
it first.

Free has a ceiling, and it is bandwidth. Relay-only means every byte crosses
your server:

| Room | Server egress | Hours on 10 TB |
|---|---|---|
| 4 people, cameras, 1080p share | ~12–16 Mbps | ~1,400–1,850 |
| 6 people, cameras, 1080p share | ~30 Mbps | ~770 |
| 4 people watching a 4K "very high" share | ~70 Mbps | ~330 |

The software is free; a server to run it on is a separate thing, and the free
ones can be reclaimed. Oracle requires a card to verify, reclaims idle
instances, and often has no ARM capacity. Keep the deployment reproducible.
Nothing here needs a paid API, SDK, font or service.

## How the encryption works

1. The link is the credential: `…/#k=<32 random bytes>`. Browsers never send a
   fragment to a server.
2. The client sends `roomId = SHA-256(secret)` to get a join token. The server
   learns an opaque id and a random identity — not the secret, not your name.
3. Each participant makes an ephemeral X25519 key pair and announces it with
   an HMAC under a key derived from the secret, over a dedicated relay.
4. Pairwise X25519 gives each pair a wrapping key; each participant wraps
   their own random media key for every peer.
5. LiveKit's frame cryptor encrypts every encoded frame and data message with
   that key (WebRTC Encoded Transform).
6. Someone joins: everyone ratchets forward. Someone leaves: everyone picks a
   fresh key.

`CLAUDE.md` lists the invariants this depends on.

## Layout

```
web/src/crypto    room secret, X25519 identity, group keys, safety numbers
web/src/call      session (media, chat, presence, host), key provider, relay client
web/src/share     presets, capture + preview controller, stats
web/src/movie     sync maths for watch-together links
web/src/chat      chat model
web/src/sfx       synthesised interface sounds
web/src/ui        components, views, room
web/src/styles    tokens, components, views, room, chat
server/src        token service, key relay, room registry, host moderation
deploy            LiveKit configs, Caddyfile, Oracle provisioning
```

## Known limits

- **Browsers differ.** Tab audio is Chromium-only; whole-screen audio is
  Windows and ChromeOS; per-application audio does not exist in browsers.
  Phones cannot capture a screen. Playing a file for the room needs
  `captureStream`, which Safari lacks. The UI says so in each case. The
  automated tests run in Chromium only.
- **4K and 60 fps are requests.** They are reached only if the source,
  the hardware and every viewer's connection allow it.
- **Six people.** A cost ceiling, not a technical one.
- **No MLS.** The design to move to is Discord's DAVE.
- **Single node**, no persistence, by design.

## Licence

MIT. LiveKit: Apache-2.0. Preact, Lucide, `@noble/*`: MIT/ISC. Geist: OFL.
