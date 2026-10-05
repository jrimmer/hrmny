# Cytale Load-Test Harness (U28)

A repeatable load-test harness that proves the Cytale architecture under
deliberate stress. Slice 1 ships the harness **core**: virtual clients, a
fan-out round with arm-before-broadcast, and a stable report shape. Later
slices add the AE1 isolation, AE2 resume, and crash-stampede scenarios.

## How to run

The harness runs against a live Cytale server (Elixir + ScyllaDB). From the
repo root:

```bash
pnpm --filter @cytale/load-test test          # unit tests (in-process fake gateway)
pnpm --filter @cytale/load-test typecheck     # type check

# CLI against a live server:
node --experimental-strip-types tools/load-test/src/index.ts \
  --clients 25 \
  --url ws://127.0.0.1:4001/gateway/websocket \
  --token <auth-token> \
  --channel <channel-id> \
  --api http://127.0.0.1:4001

# JSON output:
LOAD_TEST_JSON=1 node --experimental-strip-types tools/load-test/src/index.ts ...
```

## Expected result shape

The report is the machine-consumable contract (see `src/report.ts`):

```json
{
  "connectionsSustained": 25,
  "latency": { "p50": 1.2, "p99": 3.4 },
  "fanOutMs": { "p50": 1.2, "p99": 3.4 },
  "isolationAssertion": "pending",
  "resumeSuccessRate": 0,
  "durationMs": 100
}
```

- `connectionsSustained` — clients that connected and stayed connected.
- `latency` / `fanOutMs` — p50/p99 of per-message receive latency (ms).
- `isolationAssertion` — `pass`/`fail` once the AE1 scenario runs; `pending`
  in slice 1.
- `resumeSuccessRate` — 0..1; 0 until the AE2 resume scenario runs.

## Scenarios: armed vs pending

| Scenario | Status |
| --- | --- |
| Fan-out round (arm-before-broadcast) | **Armed** — `runFanOutRound` |
| AE1 isolation (flood A, assert B) | Armed — `isolation` |
| AE2 resume (disconnect/reconnect) | Armed — `resume` |
| Crash stampede | Armed — `crash_stampede` |
| Search freshness | Armed — `search_freshness` |
| Voice load (U13) — N=10 mutual callers, 60 s window, ≥95 % per-receiver delivery | **Armed** — `voice_load` (live server + Elixir sidecar) |
| Voice busy-call resume buffer (U13) — churn + op-23 bursts, gap-free replay ≤1000 cap | **Armed** — `voice_resume` (live server) |
| V2 video legs (U7) — cameras / stage+screens / publish-churn / TURN shapes; envelope-v2 offers, per-(user,source) receipts, video_want budgets, SDP bytes vs the 128 KiB cap, 0 leg-drops | **Armed** — `voice_video` (live server + Elixir sidecar w/ video) |

## Voice scenarios (calls plan U13)

Voice scenarios provision their OWN users/channel via the real REST API, so
`--token/--channel` are not required for them:

```bash
# N=10 mutual callers, 60s window (defaults), against a server on :4100:
pnpm exec tsx tools/load-test/src/index.ts \
  --scenario voice_load \
  --url ws://127.0.0.1:4100/gateway/websocket \
  --api http://127.0.0.1:4100/api/v1

# Busy-call resume-buffer integrity (no sidecar):
pnpm exec tsx tools/load-test/src/index.ts \
  --scenario voice_resume \
  --url ws://127.0.0.1:4100/gateway/websocket \
  --api http://127.0.0.1:4100/api/v1

# TURN leg (eturnal up; first K participants RELAY-only):
pnpm exec tsx tools/load-test/src/index.ts --scenario voice_load \
  --url ws://127.0.0.1:4100/gateway/websocket --api http://127.0.0.1:4100/api/v1 \
  --turn-url turn:127.0.0.1:3478?transport=udp --turn-secret "$ETURNAL_SECRET" --turn-only 2

# V2 video legs (U7) — four shapes via --set shape=cameras|stage|churn|turn:
pnpm exec tsx tools/load-test/src/index.ts --scenario voice_video \
  --url ws://127.0.0.1:4100/gateway/websocket --api http://127.0.0.1:4100/api/v1
pnpm exec tsx tools/load-test/src/index.ts --scenario voice_video --set shape=stage \
  --url ws://127.0.0.1:4100/gateway/websocket --api http://127.0.0.1:4100/api/v1
pnpm exec tsx tools/load-test/src/index.ts --scenario voice_video --set shape=churn \
  --url ws://127.0.0.1:4100/gateway/websocket --api http://127.0.0.1:4100/api/v1
pnpm exec tsx tools/load-test/src/index.ts --scenario voice_video --set shape=turn \
  --set turnUrl=turn:127.0.0.1:3478?transport=udp --set turnSecret="$ETURNAL_SECRET" \
  --url ws://127.0.0.1:4100/gateway/websocket --api http://127.0.0.1:4100/api/v1
```

Knobs via repeated `--set k=v`: `participants`, `signalClients`, `windowS`,
`settleS`, `pps`, `minDeliveryPct`, `callEndTimeoutMs` (voice_load);
`churnClients`, `rounds`, `burstCount` (voice_resume);
`shape`, `windowS`, `videoPps`, `minAudioPct`, `minVideoPct`, `budgetReceiver`,
`budgetTiles`, `stageTiles`, `publishDelayMs`, `churnPublishers`,
`churnIntervalMs`, `churnRounds`, `turnUrl`, `turnSecret` (voice_video). The Elixir sidecar
(`../voice-sidecar`, compiled automatically on first run) owns the real
WebRTC RTP pump/count legs; ALL gateway signaling + assertions stay on the
TS side with the real codecs (see `src/voice/` and the sidecar README for
the doctrine boundary). TURN leg: `--turn-url turn:127.0.0.1:3478?transport=udp
--turn-secret $ETURNAL_SECRET --set participants=…` — the sidecar forces its
first `VOICE_TURN_ONLY_COUNT` participants RELAY-only.

The two-real-browser e2e smoke lives at `src/voice/e2e-browser.md` (V2: it
carries the video + screenshare + desktop-handoff walkthrough — the designated
real-browser leg for the GO-simulcast branch's residual WebKit risk).

### Sidecar video legs (V2 U7)

With `video` on the sidecar request (the `voice_video` scenario sets it),
each sidecar participant: answers envelope-v2 offers (unwraps `{"v":2,…}`,
applies the inner — possibly rid-spliced — SDP), attaches one video track per
recvonly video m-line (the PUBLISHER shape: ex_webrtc 0.17 cannot originate
rid encodings — sidecar video is single-layer fallback-style, the honest
ceiling for a library-only publisher), publishes camera/screen via op-22,
pumps video-rate RTP (default 200pps × 1000B) per published source, declares
`video_want.tiles` for configured receivers, drives publish-churn storms,
and counts inbound RTP per (user, source) from the manifest's mid
attribution. Ticks carry `video: {sent, recv}`, `max_sdp_body_bytes`,
`pc_failures`, `churn_toggles` per participant; `sent`/`received` totals
stay AUDIO-only (the V1 delivery math keeps its meaning).

## Design notes

- Virtual clients use the **same** `@cytale/gateway-client` as the production
  web app — never a drifting mock. Wire encode/decode comes from
  `@cytale/protocol` (edit #14).
- The REST send path is a thin `RestSeam` interface: the CLI wires the real
  `@cytale/api-client`; the unit test injects an in-process fake gateway.
- Arm-before-broadcast: every client's `MESSAGE_CREATE` handler is registered
  in its constructor before the sender posts, so the fan-out round measures
  true end-to-end latency.
