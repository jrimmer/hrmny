# Cytale Protocol

The public contract for building Cytale clients and bots. It has two surfaces
(plus a Discord-shape compatibility layer over the REST surface):

| Surface | Transport | Status |
| --- | --- | --- |
| [Gateway](./gateway.md) | WebSocket at `/gateway/websocket` | **Shipped** (protocol v1) |
| [REST](./rest.md) | HTTP under `/api/v1` | **Shipped** (U9+) — see each page for its status |
| [Discord compat](./compat.md) | HTTP under `/api/v10` and `/api` | **Shipped** (bots plan U6+) |

The gateway is real-time and canonical: gateway events are how state change is
observed. REST is history and mutation: initial fetches, cursor-paginated
reads, and writes. No endpoint requires polling to observe a state change.

## Document map

- [`gateway.md`](./gateway.md) — connection lifecycle, opcodes, heartbeats,
  sessions and resume, compression, close codes.
- [`events.md`](./events.md) — every gateway dispatch event with its payload shape.
- [`rest.md`](./rest.md) — REST endpoint surface and conventions.
- [`compat.md`](./compat.md) — the Discord-shape compat REST subset
  (`/api/v10` + `/api` aliases): Discord objects, error-code map, rate-limit
  headers, and the pinned divergences from Discord.
- [`versioning.md`](./versioning.md) — gateway version negotiation, REST URL
  versioning, deprecation policy, field stability rules.
- [`../connectors/`](../connectors/README.md) — real pinned libraries and
  bridges pointed at Cytale: what each client requires of the server, and the
  divergences they expose.

## Conventions (both surfaces)

- **Encoding:** JSON. On the gateway every frame is a JSON document in the
  [gateway envelope](./gateway.md#envelope); see [Compression](./gateway.md#compression)
  for text-vs-binary framing.
- **IDs:** every ID is a **Snowflake — a 64-bit integer serialized as a decimal
  string**, never a JSON number (JS `Number` loses precision past 2^53−1).
  Snowflakes sort chronologically, so `before`/`after` cursor pagination and
  "newest first" ordering fall out of plain string/integer comparison.
- **Timestamps:** ISO 8601 UTC strings (e.g. `"2026-08-27T18:00:00.000Z"`),
  except where a field is explicitly documented as Unix epoch milliseconds
  (e.g. `TypingStart.timestamp`, `heartbeat_interval`).
- **Protocol version:** gateway clients send `v: 1` in Identify; see
  [Versioning](./versioning.md).

## Source of truth

The machine-readable contract lives in the `@cytale/protocol` package
(`packages/protocol/src/`) — opcodes, the event catalog with payload types,
lifecycle payloads, and runtime envelope guards. The Elixir server mirrors the
opcode table in `Cytale.Gateway.Opcode` (values must match exactly). These
docs describe that code; if they disagree with the package, the package wins
and [file an issue](https://github.com/jrimmer/hrmny/issues).

Discord's developer documentation was used as a structural reference; every
name, shape, and value here is Cytale-native.

### Server-derived manifest

`packages/protocol/manifest.json` is generated from the Elixir server by
`mix protocol.manifest` (run from `apps/server`; `--check` verifies the
committed file, `--stdout` prints without writing). It records the server's
opcode table, every gateway event name the server emits, and each event's
top-level payload field names. The file is committed and deterministic, and
`pnpm protocol:check` fails when it is stale relative to the server or disagrees
with the package or these docs — so a server-side event or payload rename
cannot pass the gate unnoticed.
