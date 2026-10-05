# U13 + V2 U7 — Two-real-browser voice/video/screenshare e2e (scripted smoke)

**Evidence status: EXECUTED 2026-09-07 — single-engine (WebKit/WKWebView, the
designated open-risk leg), two tabs of the ZCode in-app browser against the
worktree's dev stack (server :4120, vite :5174/:5175). Two DIFFERENT engines
were NOT available to that rig. The Chromium second-engine leg has since run
(2026-09-18, headless Chromium 151, scripted — see its execution log below):
the V2 publish path (steps 9–10), mute/unmute propagation (4) and the
join/leave flow are now two-engine verified with rid-encoding + decoded-frame
evidence. Steps 11/12/13/15 remain single-engine, and the visible-browser
pixel pass is only partially informed (headless pixels render and decode, but
a human-eyes pass is still owed). See "Execution log" below.**
This session had no browser tool available (the executing agent is
sandboxed without one), so per the plan's honesty rule the scripted smoke is
committed here WITHOUT fabricated evidence. Whoever runs it: follow the
steps, record observations (screenshots stay out of git per policy), and
flip the status line + PROGRESS row in the same change.

## Environment

- Server: `cd apps/server && PORT=4100 mix phx.server` (Scylla reachable on
  127.0.0.1:9042 — e.g. the `cytale-scylla` container).
- Web: `pnpm --filter @cytale/web dev` (or `pnpm build && pnpm preview` —
  check apps/web/package.json scripts); open the dev URL in TWO DIFFERENT
  browser profiles (Chrome + Firefox, or two Chrome profiles) so mic capture
  and autoplay are granted per-profile.
- TURN leg (optional but wanted for R13's e2e claim): `docker compose up -d
  eturnal` with `ETURNAL_SECRET` set in `.env`, and the server started with
  the matching `CYTALE_TURN_SECRET` so `GET /calls/ice` mints credentials.

## Accounts

Register two verified users (A and B) through the normal register + verify
flow (or reuse the load-test provisioner's mailbox flow), make them members
of one workspace with a text channel.

## Script

1. **Join** — A opens the channel, clicks the voice/call start control.
   Observe: A's compact call controls appear; a call-log thread notice or
   channel call indicator shows "1 in call"; no join sound issues.
2. **B joins** — B opens the same channel, clicks join.
   Observe: B's controls appear; A's roster shows B; a speaking indicator
   appears on whoever talks (AM5 — computed locally from received audio,
   never gateway traffic).
3. **Speak both ways** — talk alternately.
   Observe: audio flows BOTH directions; speaking rings light up; latency
   feels conversational (<300 ms on loopback).
4. **Mute/deafen** — A mutes: B sees A's muted glyph, A's audio stops, A's
   speaking indicator never lights. A deafens: A stops hearing B (and stays
   self-muted). Unmute/undeafen restores.
5. **Log exclusion** — with the call live, send a normal text message in the
   channel; the call-log thread must NOT gain entries from voice activity
   (only start/end log entries exist at most); the normal message thread
   renders as usual.
6. **Sweep** — both leave. Observe: controls dismiss; within the empty-sweep
   window (default 60 s) the call indicator disappears (CALL_END `last_left`).
7. **TURN leg (when eturnal is up)** — in ONE browser's devtools:
   `RTCPeerConnection` created with the TURN server (iceServers from
   GET /calls/ice); force relay (e.g. Chrome's
   `chrome://webrtc-internals` → selected candidate pair shows `relay`)
   and repeat steps 1–3 with that browser relay-only.
8. **Reconnect (bonus)** — with the call live, restart the server; both
   tabs return to idle via backfill (no ghost roster), and a new call starts
   immediately (this is what the soak asserts headlessly).

## V2 video + screenshare walkthrough (calls V2 plan U7)

Preconditions: both browsers on the same live call as above. This is the
designated real-browser gate for the GO-simulcast branch's residual
non-Chromium risk (the spike measured Chromium 152 only — WebKit/Safari and
the Tauri webviews are untested; a first falsification here fires the KDV4
fallback trigger).

9. **Camera on** — A clicks the camera toggle (publish `camera`).
    Observe: A's self-view tile appears (mirrored); B receives A's video
    tile (manifest-attributed, never m-line order); the roster shows A's
    camera source. With the devtools "WebRTC internals" page open on B:
    the inbound video sender on B's leg shows **3 rid encodings (q/h/f)**
    riding the wire-munged offer — the GO-simulcast browser half.
10. **Both cameras** — B enables camera too. Observe: tile grid on both
    sides; each sees the other; speaking rings stay audio-driven (AM5).
11. **Quality pickers** — A opens the receiver quality picker and drops
    max-quality to Low. Observe: B's tile on A degrades to the q layer
    (webrtc-internals inbound bitrate steps down) without freezing; the
    sender-side picker on B changes B's own send caps.
12. **Screenshare + stage** — B starts a screenshare (publish `screen`).
    Observe: B's screen becomes the STAGE (VM3 — most-recent share), A's
    view switches to stage mode with B's camera as a rail tile (VM16);
    the share-audio badge shows if B shared tab audio (VM22 house keyboard:
    `Stage`/`Alt+` switching between two simultaneous shares).
13. **Budget degradation (VM18)** — A opens enough camera tiles (or drops
    the declared budget via the receiver picker) that the budget is
    exceeded. Observe: the LEAST-recent publisher's tile degrades to an
    avatar tile with the honest "connection paused"-vs-"camera off"
    distinction; the live region announces the tile change; the STAGE and
    the current speaker are never the dropped ones (KTD2).
14. **Publish churn** — B toggles camera off/on rapidly (~2×/s for ~10 s).
    Observe: no freeze on A beyond a renegotiation beat; A's roster
    reflects each camera_on/camera_off; B's tile returns. (The headless
    storm lives in `voice_video --set shape=churn`.)
15. **Desktop handoff (U6)** — in the mobile/emulated view (or a
    capability-denied host), A taps the video affordance. Observe: the
    affordance is VISIBLE-but-disabled (VM10 — never disappearing UI);
    the dialog offers "Open in desktop app" with the bare-origin handoff
    copy (KDV3 — no deep links); the copy names what the desktop app
    unlocks (camera + screenshare) and what stays here.
16. **Video + resume** — with cameras + a screenshare live, A hard-reloads
    the tab (or toggles offline/online). Observe: after the resume, A's
    roster carries the publish sources (camera/screen markers on the
    members), streams re-attach, and the screenshare re-publishes with a
    share-ended notice only if the OS-level capture actually died (VM8).

### V2 PASS means

Steps 9–16 observed on two real browsers — DIFFERENT ENGINES preferred
(the WebKit leg is the open risk; Chrome+Firefox or Chrome+Safari both
inform). Record per browser: rid encodings present on the inbound legs
(step 9), layer behavior on the quality switch (step 11), stage switch
latency (step 12), which tile dropped under budget pressure (step 13).

## What "PASS" means

Steps 1–6 observed on two real browsers (different engines preferred), step
7 when eturnal is up. Record: browsers + versions, OS, whether TURN leg ran,
any DTX/Safari caveat observed (the plan's deferred Safari-DTX question).

## Status

- [x] EXECUTED 2026-09-07 (WebKit/WKWebView two-tab rig — engine notes above
      and below). Steps 1–6 and 8–11, 14, 16 verified; 3, 12, 13, 15 carry
      honest environment limits and recorded findings. Six real bugs found
      and fixed in the process (see Execution log). The original 2026-09-06
      PENDING note — "this session's executing agent had no browser tool" —
      was superseded by this run.
- [x] EXECUTED 2026-09-18 — Chromium second-engine leg (headless Chromium
      151.0.7922.34, scripted two-context rig
      `apps/web/e2e/calls-chromium-pass.live.spec.ts`): steps 9–10 PASS with
      rid q/h/f + `sendonly` + decoded-frame evidence, step 4 PASS live
      (F4 falsified on this engine), join/leave PASS; steps 11/12/13/15
      and the human-eyes visible-browser pixel pass remain (log below).

## Execution log (2026-09-07, WebKit/WKWebView)

Environment: macOS arm64, ZCode in-app browser (WKWebView — the open-risk
engine per the V2 PASS criteria), two tabs (isolated origins :5174/:5175,
same engine/profile), server `PORT=4120 mix phx.server` on the v2 worktree,
accounts own_voice_1788801636819_3740 (A) + usr_voice_1788801636819_3740_0
(B). Real FaceTime camera + built-in mic were accessible to the webview.

Rig limitation that shapes several observations below: the IAB pane's render
loop is paused (requestAnimationFrame and ResizeObserver callbacks never
fire while `document.visibilityState` still claims "visible"). Consequences:
react-virtuoso lists render zero items (initial measurement rides rAF) and
`<video>` frames never decode (readyState 0 on live tracks). Track/negotiation
state was therefore verified at the wire/React-prop level; a visible-browser
run should re-confirm pixels.

Per-step:

1. **Join** — PASS. Controls, roster, "Call started — 11:12 AM" log entry,
   sidebar row "voice, live call" + indented "Call — 1 participant" slot.
   (Also fixed mid-step: the Start-call affordance had been invisible in the
   real shell since V1 — `canStartCall` defaulted false and no host wired it.
   Now server-resolved via `capabilities.start` on GET /channels/:id/call.)
2. **B joins** — PASS. Both rosters, both tiles group, "2 participants".
3. **Audio both ways** — PARTIAL/environment. Media legs connected both
   directions (composite Connected, no reconnect/unavailable surfaces).
   AM5 speaking rings NOT observable: the webview's mic track delivers
   digital silence (flat-128 analyser buffer, zero noise floor, even with
   system sounds playing unmuted through the speakers). The monitor's
   WebKit start-crash ("Illegal invocation" — detached `setInterval` invoked
   with object-`this`) was found and fixed here.
4. **Mute/deafen** — PASS. B saw A's 🎙̶ roster glyph; deafen implied mute
   (AM12); unmute/undeafen restored. One unresolved observation: A's unmute
   did not clear the glyph on B's already-mounted DOM (fresh sync showed the
   correct state) — could be the paused-render rig; worth one glance in a
   visible browser.
5. **Log exclusion** — PASS (server-verified). Channel text message
   persisted (201 + GET returns it); call-log thread carried ZERO message
   rows (only start/sweep separators render, from call metadata); the
   message list itself couldn't be pixel-verified (virtuoso/rAF rig note).
6. **Sweep** — PASS. Both left at 18:57:04Z; CALL_END `last_left` at
   18:58:04Z — exactly the 60 s empty-sweep window.
7. **TURN leg** — NOT RUN (eturnal not deployed on the Mac; the R13 e2e
   claim rests on the harness's relayed-media pass from U7).
8. **Reconnect** — PASS. Hard server restart with the call live: both tabs
   returned to idle via backfill (no ghost roster), a new call started
   immediately after.
9. **Camera on** — PASS (wire-level). Server manifests carried rids
   ["f","h","q"] on the camera ingest m-line; WebKit answered `a=sendonly`
   on that line (rid negotiation accepted); self-view tile + 720p·30fps
   sender picker. The devtools rid-encoding count was not observable in
   this rig (no webrtc-internals in WKWebView).
10. **Both cameras** — PASS after fixes: both grids report live streams for
    both participants on both sides. Three WebKit-only bugs were fixed to
    get here (see below) — none were visible to the Chrome-based spike.
11. **Quality pickers** — PASS (wire-level) + one fix. Receiver Low emitted
    op-22 `video_want {tiles: 9, max_quality: "low"}` (2 s window honored);
    sender picker present (Camera quality: 720p·30fps). The receiver
    trigger's label lagged one render behind (non-reactive engine read) —
    fixed via a want-channel subscription in PublishControls.
12. **Screenshare + stage** — NOT EXERCISABLE here: WKWebView exposes
    `getDisplayMedia` but it throws `NotSupportedError` (no OS picker
    bridge). FINDING F5: the click is then completely silent — no VM10
    visible-disabled affordance state, no explanatory dialog, no KDV3
    desktop-handoff copy. Needs a designed surface (morning review).
13. **Budget degradation (VM18)** — NOT EXERCISABLE with 2 participants
    (tiles budget 9; degrading requires ≥10 cameras). The headless
    `voice_video --set shape=churn`/budget storm remains the coverage.
14. **Publish churn** — PASS. 10 camera toggles at ~1/s: the server logged
    10 offer→answer cycles, each applied in ~50 ms, zero failures, no
    wedged legs; the tile returned on B's re-enable.
15. **Desktop handoff (U6/VM10)** — NOT EXERCISED (desktop-class host; the
    capture-failure silence in F5 swallowed the expected dialog path).
16. **Video + resume** — PASS (verifiable half). After a hard reload and
    manual rejoin, A's roster carried B's camera source mark and B's
    stream re-attached (live tile). Hard-reload AUTO-rejoin does not fire —
    AM4's rejoin is scoped to gateway RESUME (a fresh page mints a fresh
    session with no resume token); consistent with the design and with
    Discord's fresh-session behavior. FINDING F6: the access token (15 min
    TTL) expired mid-session without any client-side refresh attempt — the
    gateway silently stopped accepting commands until re-login.

### Bugs found and fixed during the walkthrough (all browser-only classes)

- **W1** (V1-era, product): Start-call button never rendered in the real
  shell — `canStartCall` prop defaulted `false`, never host-wired. Fixed:
  the call REST endpoint returns server-resolved `capabilities.start`; the
  pane falls back to it when the host doesn't assert.
- **W3** (V1-era, WebKit): `SpeakingMonitor` stored detached
  `setInterval`/`clearInterval` and invoked them with object-`this` — WebKit
  throws "Illegal invocation" (Chrome tolerates), crashing every join at
  `monitor.start()`. Fixed with `.bind(globalThis)` defaults.
- **W4** (V1-era, ALL real browsers, critical): after Identify negotiated
  payload compression, the server ran EVERY client frame through the zstd
  decoder — but clients (web, and every automated leg, which all force
  `none`) send plain JSON. First post-Identify command (presence op-3, or
  the first heartbeat at 30 s) closed the socket 4001 → resume loop → the
  ~33 s session-flap cycle (very likely the real mechanism behind the
  recorded "~30 s flash" reports). Fixed by changing the contract to
  Discord semantics — payload compression is server→client only
  (`gateway_socket.ex` `connection_codec`, test support, protocol doc;
  187 gateway tests green).
- **W5** (V2, WebKit): `bindOwnTracksByManifest` never set
  `transceiver.direction = 'sendonly'` before answering the server's
  recvonly ingest offers — WebKit answered `a=inactive` and then rejected
  the follow-up renegotiation outright (m-line port 0), wedging every
  publish at "connecting video". Chrome tolerated the missing flip, which
  is why the Chrome-only spike was green. Fixed (same declaration as the
  VM5 mic-upgrade path).
- **W6** (V1-era, all engines): `notifyVideo` mutated the same Map it
  snapshotted — the `snapshot === map` guard always short-circuited, so
  video-track arrivals NEVER re-rendered React (tiles stuck at
  "connecting video" forever even with the track attributed). Fixed with a
  fresh-identity snapshot per change.
- **W7** (V2, minor): the quality pickers' trigger labels read the engine
  non-reactively and lagged one render behind the wire op. Fixed via a
  want-channel subscription in PublishControls.

### Open items handed to the morning review

- F5 (screenshare silent-failure surface), F6 (no client token refresh),
  F4-observation (unmute glyph not clearing on a peer's live DOM — DOES NOT
  reproduce on Chromium, see the 2026-09-18 log), the Chromium second-engine
  leg (Pass-1 shape now run 2026-09-18; steps 11/12/13/15 remain), and a
  visible-browser pixel pass over the video tiles + message list.

## Execution log (2026-09-18, Chromium second-engine leg — #46 pass 1)

Engine: headless Chromium 151.0.7922.34 (Playwright-bundled), TWO isolated
contexts (different storage partitions = two members), fake camera + mic
devices (`--use-fake-device-for-media-stream` — both "cameras" render the
moving fake pattern, both "mics" emit a tone), dev stack :5173/:4000 on
current main, macOS arm64. The rig + assertions live in
`apps/web/e2e/calls-chromium-pass.live.spec.ts` (runs at 1x and 4x DPR): A
registers + seeds workspace/channel, mints an invite, B joins through it; A
starts a SILENT call from the channel header; B joins via the same header;
A publishes camera; B publishes camera; A mute → unmute; B leaves; A
leaves. Screenshots (untracked) in
`docs/research/screenshots/2026-09-15-calls-chromium-pass/`.

- **Steps 9–10 PASS (media-honest).** A's camera publish puts the
  `camera` glyph on BOTH rosters (op-22 publish → server roster → both
  clients); after B's publish each roster carries TWO camera glyphs; and
  each side DECODES the other's video — getStats `inbound-rtp
  framesDecoded > 0` asserted on both pages off the app's real peer
  connections. The tile grid renders both live feeds in pixels (captures).
- **Step 9's rid-encoding observation (the half WKWebView could not
  expose).** A's camera sender reports exactly the three rid-munged
  encodings `["q","h","f"]` via getParameters, and the video transceiver
  direction reads `sendonly` — W5's declaration verified on the engine
  that originally tolerated its absence. Sessions rode the post-W4
  gateway with zero 4001/decode closes.
- **Step 4 PASS live (F4 falsified on Chromium).** The mute glyph appears
  on the peer's already-mounted roster AND clears on unmute on both sides
  — F4's "unmute didn't clear on the peer's live DOM" does not reproduce
  here. One rig lesson with diagnostic value: op-22 `state` rides the
  gateway's 900 ms human-paced throttle (`@call_op_throttle_ms`, silent
  swallow), so a mute→unmute inside one window leaves the server — and
  the roster, which renders SERVER truth — muted while the local control
  shows unmuted. The rig paces 1 s; a human reporting "unmute is broken"
  may be seeing this window.
- **Join/leave flow PASS.** Silent start (`header-start-call`), header
  join (`header-join-call`), both panels `connected`, two roster rows per
  side; B's leave drops A to one row with only A's own camera glyph; A's
  leave hides the panel. Both engines.
- **Honesty note on the first draft.** The spec originally expected
  `roster-source` glyphs after the SILENT joins and "stalled" there.
  Diagnosis: no stall — microphone audio is the V1 call itself, never a
  roster `sources[]` entry (CALL_SOURCE_KINDS is camera/screen/
  screen_audio only), so a silent join correctly renders zero source
  glyphs; voice was connected and the publish path worked the moment it
  was actually driven. The silent joins now assert roster ROWS; the
  glyphs are asserted on the real publishes.
- **Not covered on engine 2 (remains single-engine):** step 11's layer
  step-down observation, 12 screenshare/stage, 13 budget degradation, 15
  desktop handoff, 16 reload/resume. Fake devices also mean no real audio
  (step 3/AM5 speaking rings stay WebKit-evidenced only). The
  visible-browser pixel pass is partially informed — headless Chromium
  renders DECODED tiles (the WebKit IAB paused-rAF artifact does not
  exist here) — but a human-eyes pass on a visible browser is still the
  honest form of that item.
