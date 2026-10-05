#!/usr/bin/env node
// probe-sink.mjs — tiny JSON sink for device-interop probing. Zero dependencies
// (node:http + node:fs only).
//
// Why: an Android (or any) client on the far side of `adb` needs a dead-simple,
// always-up HTTP endpoint to POST telemetry to while a gateway/call flow is
// driven. This records ONE LINE PER REQUEST so `tail -f /tmp/cytale-probe.jsonl`
// (or a foreground run) shows exactly what the device sent, in order.
//
// Reachability from an Android device/emulator:
//
//     adb reverse tcp:41999 tcp:41999
//
// That makes the DEVICE's own 127.0.0.1:41999 loop back to this host process,
// so the device can POST to http://127.0.0.1:41999/ and land here. (`adb
// reverse` is per-connection — re-run it after a device reconnect.) A GET / is
// answered 204 so the device can prove the tunnel is up before it starts.
//
// The app side of this contract is apps/mobile/src/calls/devSink.ts, which
// POSTs `{ tag, at, ...payload }` to whatever EXPO_PUBLIC_CYTALE_PROBE_SINK
// holds. Point that at this listener for a device run:
//
//     EXPO_PUBLIC_CYTALE_PROBE_SINK=http://127.0.0.1:41999/ npx expo start
//
// (the device resolves that 127.0.0.1 through adb reverse, above).
//
// Contract:
//   GET  /  → 204 (reachability check)
//   POST /  → 204; the body is recorded as one JSON line
//   *    *  → 404 (nothing else is served)
//
// Recording fidelity: the body is parsed as JSON and re-serialized COMPACTLY,
// so every recorded line is valid JSON on exactly one line even when the sender
// pretty-prints. A body that is not valid JSON is recorded as {"_raw":"..."}.
// The same line is printed to stdout prefixed `SINK `. Append is synchronous
// (open/write/close per line), so a concurrent `tail -f` sees each line the
// moment it is accepted — no buffering, no flush delay.
//
// Usage:
//   node scripts/probe-sink.mjs          # foreground
//   scripts/probe-sink.sh                # same, via the wrapper
//
// Env:
//   CYTALE_PROBE_PORT   listen port                 (default 41999)
//   CYTALE_PROBE_HOST   bind address                (default 127.0.0.1)
//   CYTALE_PROBE_OUT    jsonl to append to          (default /tmp/cytale-probe.jsonl)

import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.CYTALE_PROBE_PORT ?? 41999);
const HOST = process.env.CYTALE_PROBE_HOST ?? "127.0.0.1";
const OUT = process.env.CYTALE_PROBE_OUT ?? "/tmp/cytale-probe.jsonl";
const MAX_BODY = 8 * 1024 * 1024; // 8 MiB — a probe payload is tiny; cap anyway.

// One line per request: parse → compact re-serialize (always valid JSONL).
function toLine(raw) {
  const text = raw.trim();
  if (text === "") return "{}";
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return JSON.stringify({ _raw: text });
  }
}

function record(line) {
  const entry = line + "\n";
  try {
    fs.appendFileSync(OUT, entry, "utf8"); // sync: visible to `tail -f` at once
  } catch (err) {
    console.error(`SINK ! could not append to ${OUT}: ${err.message}`);
  }
  process.stdout.write(`SINK ${line}\n`);
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && path === "/") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "POST" && path === "/") {
    let body = "";
    let dropped = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (body.length + chunk.length > MAX_BODY) {
        dropped = true;
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (dropped) {
        // Still 204: the sink never fails a probe. Record the fact instead.
        record(JSON.stringify({ _error: "body too large", limit: MAX_BODY }));
      } else {
        record(toLine(body));
      }
      res.writeHead(204).end();
    });
    req.on("error", () => {
      res.writeHead(400).end();
    });
    return;
  }

  res.writeHead(404).end();
});

server.on("error", (err) => {
  console.error(`SINK ! listen failed on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.error(`SINK listening on http://${HOST}:${PORT}  →  ${OUT}`);
  console.error(`SINK   device reach: adb reverse tcp:${PORT} tcp:${PORT}`);
  console.error("SINK   POST / records one line; GET / answers 204; Ctrl-C to stop");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Do not linger if a keep-alive socket refuses to drain.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
