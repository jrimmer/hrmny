# Voice sidecar (calls plan U13)

An Elixir mix project that runs N **headless voice participants** against a live
Cytale server: gateway WebSocket signaling (Identify → op-22 join → op-23
offer/answer + ICE) with a real `ex_webrtc` PeerConnection per participant,
plus a synthetic RTP pump (Opus-shaped packets at a fixed rate) and per-leg
inbound RTP counting — the fan-out falsification the spike's `fanout.ex`
performed against a bare SFU, now driven through the REAL Cytale gateway and
`Cytale.Calls.Media` SFU.

## Doctrine boundary (deliberate, documented)

The U28 load-harness doctrine says virtual clients use the real wire codecs —
never a drifting mock. For voice the harness is split:

- **TS harness (`tools/load-test/src/voice/`)** remains the
  **codec-authoritative** path: it imports `@cytale/protocol` and
  `@cytale/gateway-client` (the production client) and owns ALL call-control
  assertions (CALL_START/UPDATE/END/roster, resume-buffer integrity, CALL_SYNC
  checks, op-22 verbs).
- **This sidecar** owns only what pure TS cannot: a real WebRTC remote end. It
  speaks the gateway wire with a minimal RFC 6455 client (ported subset of
  `apps/server/test/support/ws_client.ex` — no transport/payload compression)
  and hand-rolled op/dispatch envelope maps. That duplication is acceptable
  FOR THE SIDECAR ONLY because the TS harness keeps the codec contract honest;
  if ops 22/23 or the CALL_* shapes ever drift, the TS scenarios fail first.

## Usage (normally driven by the TS harness — `voice` scenarios)

```bash
cd tools/load-test/voice-sidecar
mix deps.get && mix compile

VOICE_GATEWAY_HOST=127.0.0.1 VOICE_GATEWAY_PORT=4100 \
VOICE_GATEWAY_PATH=/gateway/websocket \
VOICE_TOKENS_FILE=/tmp/voice-tokens.json \
VOICE_CHANNEL_ID=123... VOICE_DURATION_S=60 VOICE_PPS=50 \
mix run --no-halt
```

| Env | Default | Meaning |
| --- | --- | --- |
| `VOICE_GATEWAY_HOST` | 127.0.0.1 | gateway host |
| `VOICE_GATEWAY_PORT` | 4100 | gateway port |
| `VOICE_GATEWAY_PATH` | /gateway/websocket | gateway WS path |
| `VOICE_GATEWAY_TLS` | unset | set `1`/`true` to dial the gateway over TLS (`:ssl`, OTP-default verification — system cacerts + hostname check). Unset plaintext is sanctioned only for the loopback topology; a non-loopback plaintext host logs one loud warning at connect (the Identify bearer crosses the socket). |
| `VOICE_TOKENS_FILE` | — (required) | JSON array of auth tokens, one per participant |
| `VOICE_CHANNEL_ID` | — (required) | channel snowflake (string) |
| `VOICE_PARTICIPANTS` | token count | how many participants to run |
| `VOICE_DURATION_S` | 60 | measurement window |
| `VOICE_PPS` | 50 | RTP pump rate per participant (audio 50 pps) |
| `VOICE_PAYLOAD_BYTES` | 160 | RTP payload size (incl. the 16 B timestamp prefix) |
| `VOICE_TURN_URL` | — | e.g. `turn:127.0.0.1:3478?transport=udp` |
| `VOICE_TURN_SECRET` | — | shared secret for REST-auth credential minting |
| `VOICE_TURN_ONLY_COUNT` | 0 | first K participants are RELAY-only (TURN falsification) |
| `VOICE_LABEL_PREFIX` | v | participant label prefix |
| `VOICE_VIDEO` | 0 | `1` = enable the V2 video plane (below) |
| `VOICE_VIDEO_PPS` | 200 | video RTP pump rate per published source |
| `VOICE_VIDEO_BYTES` | 1000 | video RTP payload size (incl. the 16 B timestamp prefix) |
| `VOICE_CAMERA_COUNT` | 0 | first K participants publish camera (op-22 + video pump) |
| `VOICE_SCREEN_COUNT` | 0 | first K participants ALSO publish screen (multi-share/stage shape) |
| `VOICE_PUBLISH_DELAY_MS` | 2000 | delay after connect before the first publish |
| `VOICE_TILES_JSON` | {} | `{idx: tiles}` — those receivers declare `video_want.tiles` |
| `VOICE_CHURN_PUBLISHERS` | 0 | first K participants toggle camera publish/unpublish |
| `VOICE_CHURN_INTERVAL_MS` | 400 | ms between churn toggles |
| `VOICE_CHURN_ROUNDS` | 8 | toggles per churn publisher (storm ends published) |

## Output contract (stdout, one JSON per line — the TS harness parses these)

- `VOICE_META {…}` once at start (n, pps, duration_s, turn_only).
- `VOICE_TICK {…}` every 5 s: per-participant counters (connected, sent,
  received, offers applied, answers sent, ICE sent, last/max latency ms,
  inbound track count).
- `VOICE_FINAL {…}` at window end (or when every WS dropped): adds the
  steady-window delivery percentage — `(Δreceived) / ((n−1) × pps × Δt)` over
  the window that starts at the first tick with every participant connected —
  plus per-participant negotiation timings. Exit status 0.

With `VOICE_VIDEO=1` every tick/final also carries, per participant:
`max_sdp_body_bytes` (largest CALL_SIGNAL body seen, vs the 128 KiB cap),
`pc_failures` (connection failed/disconnected transitions — leg-drop
evidence), `video_sent`/`video_received` (packet totals), 
`max_video_latency_ms`, `churn_toggles`, and `video: {"sent": %{source =>
n}, "recv": %{"user/source" => n}}` — per-source counters attributed from
the envelope-v2 manifest's mids (never m-line order). `sent`/`received`
stay AUDIO-only so the V1 delivery math keeps its meaning. Video legs are
single-layer (ex_webrtc 0.17 cannot originate rid encodings): receivers see
full-rate streams inside their budgets — the honest fallback-branch ceiling;
the GO-branch q-layer rates need real browsers (e2e-browser.md).

The sidecar never mutates repo state; it only reads `VOICE_TOKENS_FILE`
(minted by the TS harness via the real REST API).
