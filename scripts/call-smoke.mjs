#!/usr/bin/env node
// call-smoke.mjs — end-to-end CALL CONTROL smoke test against a local Cytale
// dev server (:4000 by default).
//
// What it proves (the server side of a call, no real WebRTC handshake):
//   1. GET /api/v1/calls/ice answers with the caller's ICE config (empty
//      server list on a no-TURN deployment — host candidates only).
//   2. Two authenticated clients Identify on /gateway/websocket (native v1).
//   3. A opens a call in a real channel with op 22 {action:"start"}; the
//      server answers with CALL_UPDATE state=joined for A (the caller's leg).
//   4. B joins with op 22 {action:"join"}; the server answers with
//      CALL_UPDATE state=joined for B.
//   5. The server, as the SOLE OFFERER, pushes a CALL_SIGNAL sdp offer to B's
//      leg (envelope-v2 body: {"v":2,"type":"offer","sdp":...,"tracks":[...]}).
//   6. GET /channels/:id/call reports the LIVE roster from the room registry.
//   7. Leave tears the legs down again (roster back to empty).
//
// No app code is imported: everything rides the public HTTP + WebSocket
// surfaces, so this is a black-box client. Node's built-in fetch and
// built-in WebSocket (Node >= 22) mean zero dependencies.
//
// Usage:  node scripts/call-smoke.mjs      (or scripts/call-smoke.sh)

const BASE = (process.env.CYTALE_SMOKE_BASE ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const WS_URL = BASE.replace(/^http/, "ws") + "/gateway/websocket";
const MAILBOX =
  process.env.CYTALE_DEV_MAILBOX ?? "apps/server/tmp/dev_mailbox.jsonl";
const PASSWORD = "password-123";

// -- tiny report harness -------------------------------------------------------

const results = [];
function record(ok, label, detail) {
  results.push({ ok, label, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${label}${detail ? `\n         ${detail}` : ""}`);
}
function assert(cond, label, detail) {
  record(!!cond, label, detail);
  return !!cond;
}
function info(label, detail) {
  console.log(`  [info] ${label}${detail ? `\n         ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- HTTP --------------------------------------------------------------------

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

async function apiOrDie(method, path, opts, label) {
  const res = await api(method, path, opts);
  if (res.status >= 300) {
    throw new Error(`${label} failed: HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

// Same, but tolerates the transient denial a JUST-created workspace can return
// while its rights epoch settles (observed on a loaded box: the owner gets one
// 403 forbidden from MANAGE_CHANNELS immediately after POST /workspaces, and
// the identical call succeeds moments later).
async function apiRetry(method, path, opts, label, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await api(method, path, opts);
    if (last.status < 300) return last.json;
    if (last.status !== 403 && last.status !== 404) break;
    await sleep(750 * (i + 1));
  }
  throw new Error(`${label} failed: HTTP ${last.status} ${JSON.stringify(last.json)}`);
}

// -- dev-mailbox verification (no SMTP in dev: the token goes to a FILE) ------

async function latestVerificationToken(email) {
  const fs = await import("node:fs/promises");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(MAILBOX, "utf8");
      for (const line of raw.split("\n").reverse()) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.kind === "verify_email" && entry.to === email) return entry.token;
      }
    } catch {
      /* mailbox not written yet */
    }
    await sleep(250);
  }
  throw new Error(`no verify_email token for ${email} in ${MAILBOX} (set CYTALE_DEV_MAILBOX)`);
}

// Register → verify (from the dev mailbox) → login, so the account is NOT
// view-only (CYTALE_REQUIRE_VERIFIED=true is the default).
async function makeVerifiedUser(tag) {
  const suffix = `${tag}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  const username = `csmoke${suffix}`;
  const email = `${username}@example.com`;

  const reg = await apiOrDie(
    "POST",
    "/api/v1/auth/register",
    { body: { username, email, password: PASSWORD } },
    "register",
  );

  const token = await latestVerificationToken(email);
  await apiOrDie("POST", "/api/v1/auth/verify-email", { body: { token } }, "verify-email");

  const login = await apiOrDie(
    "POST",
    "/api/v1/auth/login",
    { body: { identifier: username, password: PASSWORD } },
    "login",
  );
  if (!login.email_verified) {
    throw new Error(`account ${username} is still unverified after verify-email`);
  }
  return { username, email, userId: reg.user.id, token: login.access_token };
}

// -- minimal gateway client --------------------------------------------------

class Gateway {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.frames = [];
    this.waiters = [];
    this.closed = null;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
      ws.addEventListener("close", (ev) => {
        this.closed = ev.code;
        this.#flush();
      });
      ws.addEventListener("error", () => reject(new Error(`${this.name}: ws error`)));
      ws.addEventListener("open", () => resolve());
    });
  }

  #onMessage(data) {
    let json;
    try {
      json = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(json);
    } else {
      this.frames.push(json);
    }
  }

  #flush() {
    while (this.waiters.length) {
      const w = this.waiters.shift();
      clearTimeout(w.timer);
      w.resolve(null);
    }
  }

  send(op, d) {
    this.ws.send(JSON.stringify({ op, d }));
  }

  // Next frame matching `pred` (unrelated frames are consumed and dropped so
  // interleaved fan-out cannot wedge the wait). null on timeout/close.
  async next(pred, timeoutMs = 6_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.frames.findIndex(pred);
      if (idx >= 0) return this.frames.splice(idx, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.closed !== null) return null;
      const frame = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = this.waiters.findIndex((w) => w.timer === timer);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(null);
        }, remaining);
        this.waiters.push({ resolve, timer });
      });
      if (frame) this.frames.push(frame);
      if (!frame && this.closed === null && !this.frames.some(pred)) {
        // loop re-checks the deadline
      }
    }
  }

  // Every frame that arrives until the socket goes quiet for `quietMs`.
  async collectQuiet(quietMs = 400, maxMs = 4_000) {
    const out = [...this.frames.splice(0)];
    const deadline = Date.now() + maxMs;
    for (;;) {
      const remaining = Math.min(quietMs, deadline - Date.now());
      if (remaining <= 0 || this.closed !== null) return out;
      const frame = await this.next(() => true, remaining);
      if (frame) out.push(frame);
      else return out;
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

async function identify(conn, token) {
  conn.send(2, {
    token,
    v: 1,
    compress: null,
    properties: { os: "smoke", browser: "call-smoke", device: "script" },
  });
  const ready = await conn.next((f) => f.op === 0 && (f.t === "Ready" || f.t === "READY"), 6_000);
  if (!ready) throw new Error(`${conn.name}: no READY after Identify (closed=${conn.closed})`);
  return ready.d;
}

// -- call target (guild channel, else DM) ------------------------------------

async function openCallTarget(alice, bob) {
  try {
    const ws = await apiOrDie(
      "POST",
      "/api/v1/workspaces",
      { token: alice.token, body: { name: `smoke-${Date.now()}` } },
      "workspace create",
    );
    // Create responses are WRAPPED ({"workspace": {...}} / {"channel": {...}}).
    const workspaceId = ws.workspace?.id ?? ws.id;

    // The workspace row must be READABLE before its owner passes
    // MANAGE_CHANNELS (the plug resolves the owner from it).
    const started = Date.now();
    let readable = false;
    for (let i = 0; i < 24; i++) {
      const g = await api("GET", `/api/v1/workspaces/${workspaceId}`, { token: alice.token });
      if (g.status === 200) {
        readable = true;
        break;
      }
      if (g.status !== 404) break;
      await sleep(5_000);
    }

    if (!readable) throw new Error("workspace never became readable");

    const ch = await apiRetry(
      "POST",
      `/api/v1/workspaces/${workspaceId}/channels`,
      { token: alice.token, body: { name: "voice-smoke", type: "text" } },
      "channel create",
    );

    // Bob becomes a member through the sanctioned invite flow.
    const invite = await apiOrDie(
      "POST",
      `/api/v1/workspaces/${workspaceId}/invites`,
      { token: alice.token, body: { max_age_s: 600, max_uses: 1 } },
      "invite create",
    );
    await apiOrDie(
      "POST",
      `/api/v1/invites/${invite.invite.code}`,
      { token: bob.token, body: {} },
      "invite accept",
    );

    return {
      route: "workspace-channel",
      channelId: ch.channel?.id ?? ch.id,
      detail:
        `workspace=${workspaceId} channel=${ch.channel?.id ?? ch.id} ` +
        `readable after ${((Date.now() - started) / 1000).toFixed(1)}s`,
    };
  } catch (err) {
    info(`workspace channel unavailable (${err.message}) — falling back to a DM channel`);
  }

  const dm = await apiOrDie(
    "POST",
    `/api/v1/users/${bob.userId}/channels`,
    { token: alice.token, body: {} },
    "dm create",
  );
  const dmChannel = dm.id ?? dm.channel?.id;
  return { route: "dm-channel", channelId: dmChannel, detail: `dm channel=${dmChannel}` };
}

// -- main --------------------------------------------------------------------

async function main() {
  console.log(`Cytale call smoke test → ${BASE}\n`);

  // 0. liveness
  const health = await api("GET", "/health");
  assert(health.status === 200, `GET /health 200`, `got ${health.status}`);
  if (health.status !== 200) throw new Error("server not healthy on :4000");

  // 1. accounts (verified, so the content-mutation gate does not block)
  const alice = await makeVerifiedUser("a");
  const bob = await makeVerifiedUser("b");
  console.log(`  accounts: ${alice.username} / ${bob.username}\n`);

  // 2. ICE config — no TURN on a local run: an EMPTY server list.
  const ice = await apiOrDie("GET", "/api/v1/calls/ice", { token: alice.token }, "calls/ice");
  assert(
    Array.isArray(ice.ice_servers) && ice.ice_servers.length === 0,
    "GET /api/v1/calls/ice → host candidates only (empty ice_servers)",
    JSON.stringify(ice),
  );

  // 3. a call target.
  //
  //     Preferred: a real workspace channel (the guild path — MANAGE_CHANNELS,
  //     the channel gate, INVITE + accept membership). On a freshly booted
  //     dev box the workspace row can be unreadable for a while after
  //     POST /workspaces (GET /workspaces/:id 404s, so the permission plug
  //     cannot see the owner and DENIES channel creation), so the read is
  //     polled with a bounded budget and the lag is reported.
  //
  //     Fallback: a DM channel (POST /users/:id/channels), which is created
  //     from existing user rows and readable immediately — the DM room branch
  //     of op 22 is production code (no START_CALL check; participation is
  //     authorization).
  const target = await openCallTarget(alice, bob);
  const channelId = target.channelId;
  info(`call target route: ${target.route}`, target.detail);
  assert(!!channelId, "a call target channel exists", `channel=${channelId}`);

  // 4. gateway sessions
  const connA = new Gateway("alice");
  const connB = new Gateway("bob");
  await connA.open();
  await connB.open();
  await identify(connA, alice.token);
  await identify(connB, bob.token);
  assert(true, "both clients Identify on /gateway/websocket (native v1, READY)");

  // 5. A starts the call
  connA.send(22, { channel_id: String(channelId), action: "start", ring: false });
  const aJoined = await connA.next(
    (f) => f.t === "CallUpdate" && f.d?.user_id === alice.userId && f.d?.state === "joined",
    8_000,
  );
  assert(
    !!aJoined,
    "op 22 start → CALL_UPDATE joined for the caller (leg issued)",
    aJoined ? `leg=${aJoined.d.leg} call_id=${aJoined.d.call_id}` : "no joined update",
  );
  const aOffer = await connA.next(
    (f) => f.t === "CallSignal" && f.d?.channel_id === String(channelId),
    8_000,
  );
  const aOfferBody = aOffer ? safeParse(aOffer.d.body) : null;
  assert(
    aOfferBody?.type === "offer" && typeof aOfferBody.sdp === "string" && aOfferBody.sdp.length > 0,
    "server pushed the SOLE-OFFER sdp offer to the caller's leg (CALL_SIGNAL)",
    aOfferBody
      ? `v=${aOfferBody.v} type=${aOfferBody.type} sdp=${aOfferBody.sdp.length}B tracks=${(aOfferBody.tracks ?? []).length}`
      : "no CallSignal arrived",
  );

  // 6. B joins
  connB.send(22, { channel_id: String(channelId), action: "join" });
  const bJoined = await connB.next(
    (f) => f.t === "CallUpdate" && f.d?.user_id === bob.userId && f.d?.state === "joined",
    8_000,
  );
  assert(
    !!bJoined,
    "op 22 join → CALL_UPDATE joined for the joining participant",
    bJoined ? `leg=${bJoined.d.leg} call_id=${bJoined.d.call_id}` : "no joined update",
  );

  // 7. The joiner's own offer — the leg that would carry media.
  const bOffer = await connB.next(
    (f) => f.t === "CallSignal" && f.d?.channel_id === String(channelId),
    8_000,
  );
  const bOfferBody = bOffer ? safeParse(bOffer.d.body) : null;
  assert(
    bOfferBody?.type === "offer" && typeof bOfferBody.sdp === "string" && bOfferBody.sdp.length > 0,
    "server pushed the SOLE-OFFER sdp offer to the JOINING client's leg (CALL_SIGNAL)",
    bOfferBody
      ? `v=${bOfferBody.v} type=${bOfferBody.type} sdp=${bOfferBody.sdp.length}B tracks=${JSON.stringify(bOfferBody.tracks)}`
      : "no CallSignal arrived",
  );

  // Alice learns Bob joined (channel-keyed roster fan-out).
  const aSawBob = await connA.next(
    (f) => f.t === "CallUpdate" && f.d?.user_id === bob.userId && f.d?.state === "joined",
    8_000,
  );
  assert(!!aSawBob, "existing participant sees CALL_UPDATE joined for the joiner (roster fan-out)");

  // 8. Durable/live read surface
  const callState = await apiOrDie(
    "GET",
    `/api/v1/channels/${channelId}/call`,
    { token: bob.token },
    "channel call state",
  );
  const n = callState.live?.participants?.length ?? 0;
  assert(
    n === 2,
    "GET /channels/:id/call reports the live call with both participants",
    `live.call_id=${callState.live?.call_id} participants=${n} capabilities=${JSON.stringify(callState.capabilities)}`,
  );

  // 9. ICE trickle is accepted from a participant (op 23, no reply expected).
  connB.send(23, {
    channel_id: String(channelId),
    kind: "ice",
    body: JSON.stringify({ candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 }),
  });
  connB.send(1, null); // heartbeat — proves the socket survived the signalling
  const ack = await connB.next((f) => f.op === 11, 5_000);
  assert(!!ack, "op 23 ICE relay accepted; socket alive afterwards (heartbeat ack op 11)");

  // 10. leave → legs torn down
  connA.send(22, { channel_id: String(channelId), action: "leave" });
  connB.send(22, { channel_id: String(channelId), action: "leave" });
  await sleep(600);
  const after = await apiOrDie(
    "GET",
    `/api/v1/channels/${channelId}/call`,
    { token: alice.token },
    "channel call state after leave",
  );
  assert(
    (after.live?.participants?.length ?? 0) === 0,
    "leave → live roster empty again (legs torn down)",
    `participants=${after.live?.participants?.length ?? 0}`,
  );

  connA.close();
  connB.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((f) => f.label).join("; ")}`);
    process.exit(1);
  }
  console.log("CALL PATH OK (server-side call control + sole-offerer signalling)");
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The box running this is often heavily loaded (other agents), so a failure
// must always be REPORTED — a bare crash with no output is useless evidence.
process.on("uncaughtException", (err) => {
  console.error(`\nSMOKE ERROR (uncaught): ${err?.stack ?? err}`);
  process.exit(2);
});
process.on("unhandledRejection", (err) => {
  console.error(`\nSMOKE ERROR (unhandled): ${err?.stack ?? err}`);
  process.exit(2);
});

main().catch((err) => {
  console.error(`\nSMOKE ERROR: ${err.message}`);
  process.exit(2);
});
