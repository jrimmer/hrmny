# Platform clients — the settled story

**Status:** decided · 2026-09-11 · amended 2026-09-13 (the terminal client row
and the SSH-mode fallback exception, below)
**Supersedes:** the per-platform capability hand-wringing that followed the
Shopify "back to native" post. That post is not an argument about this product
(see "Why not a native rewrite" below).

## The rule that ends the churn

**The web build is the complete client and the universal fallback.** Every
question of the form "can platform X do Y?" has the same escape hatch: X opens
the web app for Y. That is not a compromise, it is the product — web is where
everything is implemented first, and the shells exist to make the common case
feel at home.

Given that, capability gaps stop being blockers and become **routing decisions**.

### The exception: a member in an SSH-only session cannot be routed anywhere

The terminal client is the fourth client, and it is the one for which the rule
above does not hold. A member sitting in an SSH session has no browser in front
of them, so the escape hatch that makes every other gap a routing decision is
unavailable — there is nothing to hand off TO. Its gaps are therefore **hard
absences**, stated rather than papered over:

- No attachments (up or down): a terminal has no file picker, and a download
  would land on whichever machine the member is SSHing from.
- No message edit or delete, no notifications, no call controls.
- No creating DMs or threads, and no thread-follow or per-thread notification
  preferences — V1 reads and replies to conversations that exist.
- No workspace administration, roles, invites, or settings.
- No rich markdown beyond emphasis, bold, inline code, fenced blocks and
  blockquotes; no syntax highlighting, no inline images, no clickable links
  (links render as their text with the URL shown when it differs).

What it does cover is the loop a chat client has to cover to be worth using: the
two-column shell, reading and posting, threads in column two, search, unread
state, reactions, presence, and basic markdown. Local mode (`cytale-tui
<server-url>`, the same binary on a machine that may well have a browser) shares
those limits — the client does not offer a handoff it cannot perform, so no
affordance in the terminal opens the web app.

## Which client serves which job

| Job | Browser / PWA | Tauri desktop | RN mobile (iOS/Android) | Terminal (SSH / local) |
| --- | --- | --- | --- | --- |
| Text chat, threads, search, files | full | full | full | text, threads, search, reactions, presence, unread — **no attachments** |
| Voice / video calls | full | **hand off to the browser** | full, via native WebRTC | **absent** (deliberately not a media surface) |
| Screenshare | full | **hand off to the browser** | n/a (not a phone job) | **absent** |
| Share sheet / App Intents / widgets | n/a | n/a | **native module** | n/a |
| Lock-screen call UI, background audio | n/a | n/a | **native module** | n/a |
| Push notifications | web push | shell notification | **native module** | **absent** (no notification channel in a session) |
| OS-level integration (deep links, badges, file associations) | partial | shell | **native module** | n/a |
| Message edit / delete, admin, roles, invites, settings | full | full | full | **absent** (read-and-post client) |

## What is already true, with evidence

**Desktop (Tauri) is done and needs no more decisions.** `tauri.conf.json` sets
`bundle.targets: "all"`; CI builds Linux `.deb`/`.rpm` today, and the macOS
`.app`/`.dmg` and Windows `.msi`/`.exe` bundles need runners on those OSes (a
small, later task — the macOS bundle builds locally on this machine).

The media story is not "Tauri can't"; it is **built and honest**:
`apps/web/src/features/calls/capability/` probes each surface in two steps
(API presence, then a dry-run capture whose tracks are stopped immediately),
because on macOS WKWebView `getDisplayMedia` exists and still hangs — so
presence checks alone lie. When a surface is `unavailable` the affordance is
replaced by a handoff (`handoff.ts`) that opens the configured web origin in the
user's default browser; the user logs in there, the V1 one-leg-per-user rule
displaces the desktop leg, and the shell shows "Call continued in your
browser." A *user refusal* (`denied`) is deliberately never rendered as platform
incapability, and it is retryable. Linux (WebKitGTK) cannot capture at all and
lands on the same handoff.

So: **text everywhere in the shell, calls in the browser, all three desktop
platforms.** No gaps to hold open.

**Mobile (React Native) is the mobile story.** It is shipped: 59 suites / 481
tests, a real device path on iOS 26.2, an Android release APK for the tablet,
and the Windows/Linux/macOS shells share its protocol code.

## Why not a native rewrite of mobile

Not a performance claim — Shopify's own post says "React Native apps can be
fast. Ours are," and does not offer performance as a reason. The reason is
arithmetic:

- The wire contract, store, permissions, session, markdown and emoji live in
  `packages/*` — ~9.7k lines of TypeScript consumed by **three** clients. A
  Swift + Kotlin app reimplements that twice, and a chat protocol's failure mode
  under divergence is silent (seq folding, resume, watermarks), not a compile
  error.
- The Shopify argument for native is "agents make porting cheap." That is true
  for *screens*. It does not apply to a contract whose correctness is defined by
  agreement between the implementations.
- Their greenfield rewrite covered a mobile-only product. Ours would be three
  clients where the rewrite forks the one shared thing.

## How to do "mobile native" — the module boundary, not the app boundary

The user's own instinct — *native when it makes sense* — has a precise rule:

> **Native when the feature's value comes from the OS or the hardware. JS when
> the value comes from the wire.**

That puts the boundary at the module, not at the app:

- **Native modules** (Swift/Kotlin behind RN's New Architecture): CallKit /
  ConnectionService (lock-screen call UI, AVAudioSession and audio routing),
  push notifications with actions (needs server-side device-token registration,
  currently deferred), share sheet / App Intents, widgets and Live Activities,
  background refresh. Each is a bounded, individually shippable native module
  and each is the *only* way to reach that capability — a native app would need
  the same code, written the same way, in the same place.
- **JS**: everything protocol-, state- and rendering-shaped. This is where the
  shared packages live and where a rewrite would be pure loss.

The test for "does this need a native module?" is the rule above, not a platform
scorecard: if the feature is valuable because the OS mediates it, write it
natively; if it is valuable because the server agrees with it, write it in TS.

### Media specifically

`apps/web/src/features/calls/useCallMedia.ts` (~1.7k lines, the V1/V2 engine) is
written against **structural interfaces** — `PeerConnectionLike`,
`MediaTrackLike`, `RtpTransceiverLike`, `RtpSenderLike` — with the
browser-shaped parts behind `MediaEnv` / `CaptureEnv` seams. `react-native-webrtc`
exposes objects of the same shape, so mobile media is plausibly **one env
adapter plus lifting the engine into a shared package**, not a second
implementation of the SFU contract. That is what the React Native media spike
measures; its first step is
already green — the module compiles under Expo 57 / RN 0.86 with no native
hand-edits.

### The two real mobile gaps (neither is a framework limit)

1. **Tablet layout.** `apps/mobile/app.json` is `"orientation": "portrait"` and
   the release manifest follows, so the tablet build is portrait-locked; and the
   shell is the phone shell at tablet size (no tablet layout exists — plan 004
   defers it). Both are layout work.
2. **Device verification.** Android has been built and installed but its UI has
   not been exercised end to end on real hardware — the emulator dies under this
   machine's load. The physical tablet is the test.

## What this decides

- No native rewrite of mobile. Native work is scoped per module, by the rule.
- Desktop is closed: shell for text, browser handoff for media, all three OSes.
- Web stays the reference implementation and the fallback, which is what makes
  the rest of the matrix safe to ignore — with one exception: the terminal
  client serves a member whose session has no browser, so its gaps are hard
  absences and the row above is a scope statement, not a routing table.
