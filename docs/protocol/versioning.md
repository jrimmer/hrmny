# Versioning Policy

Cytale's protocol is **public, documented, and stable from launch**. Third
parties build on it, so breaking changes have a defined cost and a defined
window. Two surfaces, two mechanisms:

| Surface | Mechanism | Current version |
| --- | --- | --- |
| Gateway | Client-declared version in Identify (`v` field) | `1` |
| REST | URL path prefix (`/api/v1/...`) | `v1` |

## Gateway version negotiation

1. The client connects to `/gateway/websocket`.
2. The server's [Hello](./gateway.md#op-10-hello) frame advertises the
   accepted protocol version in `d.v` (currently `1`).
3. The client sends Identify with its requested version in `d.v`.
4. The server accepts **exactly** the version Hello advertised. Any other
   value closes the connection with close code **4012 Invalid API Version**
   (preceded by Invalid Session `false`).

There is no multi-version negotiation at launch: the client must speak
version `1`. A future gateway `v2` will be additive while `v1` ages out
according to the deprecation policy below; clients should surface the
`4012` case as "update required" rather than retry-looping.

## REST URL versioning

- Every REST path carries the version: `/api/v1/...`. Never headers alone —
  the URL stays curlable and diffable.
- A new major REST version mounts under a new prefix (`/api/v2/...`) alongside
  `/api/v1/` during the overlap window.
- Breaking changes never land inside `v1`; they define `v2`.

## Breaking vs additive changes

**Additive (allowed at any time, no version bump):**

- Adding a new event name, opcode, or endpoint.
- Adding an optional request field (server must default it safely for clients
  that don't send it).
- Adding a response field or event payload field (see field stability below).
- Adding a new error `key` — clients must treat unknown keys as generic errors.

**Breaking (requires a new version + deprecation window):**

- Removing an endpoint, event, opcode, or field.
- Changing a field's type (e.g. Snowflake string → number), semantics, or
  required/optional status.
- Renaming any field, event, or endpoint (rename = add new + deprecate old).
- Changing an error `code`/`key` pairing that clients are told to match on.

## Field stability rules

1. **Never remove a field; only add.** A field that ships stays.
2. **Rename = add new + deprecate old.** The old name keeps its value through
   the deprecation window, then a major version drops it.
3. New fields on responses/events are additive from the client's perspective
   — clients must ignore fields they don't recognize. Parsing that fails on
   unknown fields is a client bug.
4. Snowflake fields are always decimal strings, forever (this rule is itself
   stable; a numeric Snowflake would be a breaking change requiring v2).

## Deprecation windows and headers (REST)

A deprecated REST endpoint or field:

1. Is announced in the protocol changelog with its removal target.
2. Responds with both standard headers while it still works:

   ```text
   Deprecation: version="v1" (or @<unix timestamp>)
   Sunset: <HTTP-date when removal occurs, e.g. Sat, 31 Dec 2028 23:59:59 GMT>
   ```

3. Keeps working until the `Sunset` date — never removed earlier.
4. Removal happens only in a major version boundary after the window elapses.

The same discipline governs gateway fields: a field or event enters a
deprecation cycle before any removal, and the cycle is long enough that a
maintained third-party client can migrate without emergency releases.

## Gateway deprecation signals

The gateway has no HTTP headers, so deprecation surfaces as:

- **Hello `d.v`** — the server's authoritative version; a client seeing an
  unexpected value knows the server has moved on.
- **Close code 4012** — the client's Identify version is no longer accepted;
  time to upgrade.
- **Invalid Session (`d: false`)** with close `4000/4009` after a protocol
  retirement — the session's protocol era has ended; re-Identify on the
  current version.

## Delivery semantics (why clients can trust the loop)

These guarantees are part of the versioned contract:

- **At-least-once for in-window disconnects.** Dispatches are sequence-numbered
  per session and buffered for the resume window; a Resume replays exactly the
  dispatches after the client's last processed seq. A client that receives
  dispatch N can lose the connection immediately and still recover N+1...
  onward by resuming from N.
- **Optimistic sends reconcile deterministically.** REST message POSTs honor
  `Idempotency-Key`; the client-side nonce tracking and the server-side
  idempotency backstop together mean a retried send never double-posts.
- **Gateway events are canonical; REST is history.** No endpoint requires
  polling to observe a state change — state changes arrive as dispatches, and
  REST rebuilds state that resume cannot (window expiry, full-sync fallback).

Client implementations that follow this page — replay by seq, idempotent
sends, no polling — get Discord-grade reliability semantics without Discord's
admitted eventually-consistent edges.
