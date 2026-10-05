# cytale-ssh-host

The Cytale SSH host (plan U4, requirements R7, R10, R11, R12, R12a, R13, R13a,
R13b, R19a). It terminates SSH, verifies a member's OpenSSH **user
certificate**, exchanges the verified identity for a short-lived Cytale access
token, and hands the connection to the terminal client as one client process per
connection with the token arriving on an inherited descriptor.

It is the product's authentication boundary, so it does exactly this and nothing
else: it holds no member credential, stores no token on disk, and speaks no
Cytale protocol. Everything wire-shaped belongs to the client (KTD2).

## The trust boundary, in one paragraph

A connection is accepted only when the offered public key is a user certificate
signed by a CA in the configured trust set, with `CertType` of user, a principal
equal to the requested login name, and a validity window that is neither expired
nor indefinite. A certificate with an **empty principals list** (a wildcard to
the underlying check), an **indefinite window** (`CertTimeInfinity`, exempted
from the expiry check), or **any critical option** (including `source-address`,
which is admitted but not enforced by the certificate checker) is refused. A
plain public key is refused: possession of a key is not a login. No password and
no keyboard-interactive method exists. The verified identity is then asserted to
the bridge, which binds a mint to an issuance this server actually made.

## Layout

| Path | What it owns |
| --- | --- |
| `cmd/cytale-ssh-host/` | configuration, secret custody, boot ordering, the boot log line |
| `internal/auth/` | certificate verification, the trust set, the identity carrier, the host key |
| `internal/bridge/` | the HTTP client for `POST /internal/ssh/session`, and the credential |
| `internal/tokens/` | the token descriptor, its framing, and the renewal stream |
| `internal/session/` | the handoff: spawn, renewal, bounds, caps, request policy, session-end reasons |

## Configuration

Everything is read from the environment at boot, and the required set fails the
boot loudly by name rather than failing the first member's connection. There is
no environment variable that carries a **value** of the bridge credential or the
host key — both are paths, because an environment value stays readable to a
same-uid child through this process's `/proc`, and read-once-and-unlink cannot
apply to a value.

### Required

| Variable | Meaning |
| --- | --- |
| `CYTALE_SSH_HOST_CA_PUBLIC_KEY` | path to the CA public key(s), one or more lines in `authorized_keys` form |
| `CYTALE_SSH_HOST_KEY` | path to the host **private** key (read once, then unlinked) |
| `CYTALE_SSH_HOST_BRIDGE_URL` | the bridge listener's base URL, on the internal network |
| `CYTALE_SSH_HOST_BRIDGE_CREDENTIAL` | path to the bridge credential (read once, then unlinked) |
| `CYTALE_SSH_HOST_CLIENT_COMMAND` | absolute path to the terminal client entry point |
| `CYTALE_SSH_HOST_ORIGIN` | the Cytale server origin the client talks to, e.g. `https://chat.example.com` |

### Optional, with the defaults stated

| Variable | Default |
| --- | --- |
| `CYTALE_SSH_HOST_ADDR` | `:2222` |
| `CYTALE_SSH_HOST_CLIENT_ARGS` | empty (host-configured; space-separated) |
| `CYTALE_SSH_HOST_CLIENT_DIR` | the client command's directory |
| `CYTALE_SSH_HOST_CLIENT_PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `CYTALE_SSH_HOST_RETAIN_SECRETS` | `false` — see *Secret custody* |
| `CYTALE_SSH_HOST_MAX_SESSION_DURATION` | `12h` |
| `CYTALE_SSH_HOST_IDLE_TIMEOUT` | `30m` |
| `CYTALE_SSH_HOST_HANDSHAKE_TIMEOUT` | `30s` |
| `CYTALE_SSH_HOST_MAX_AUTH_TRIES` | `3` |
| `CYTALE_SSH_HOST_MAX_PREAUTH_CONNECTIONS` | `64` |
| `CYTALE_SSH_HOST_MAX_SESSIONS_TOTAL` | `128` |
| `CYTALE_SSH_HOST_MAX_SESSIONS_PER_ACCOUNT` | `4` |
| `CYTALE_SSH_HOST_MAX_SESSIONS_PER_CONNECTION` | `2` |

## Secret custody (R12a)

The bridge credential and the host private key are read **once** at boot and then
**unlinked**, before the listener is opened. A client process running under the
same uid as the host therefore cannot open them: the assertion in the suite is
the child's own `open()` failure, not the absence of an environment variable —
which passes while the file is still readable.

The CA **public** key is not a secret and stays on disk.

`CYTALE_SSH_HOST_RETAIN_SECRETS=true` is the one documented alternative: when the
deployment runs the client under a **distinct uid**, the host's readability is
not the member's process's readability, so the unlink is unnecessary and the
operator owns the file's mode. Nothing else about the posture changes.

## The child process

One process per connection (R12). Its shape is fixed:

* **standard input and output** are the PTY slave the SSH `pty-req` allocated,
  so the client draws on the member's terminal and receives their keystrokes;
* **one inherited descriptor** carries tokens and the session-end reason:
  `ExtraFiles[0]`, which the child sees at **fd 3**, with the number passed in
  `CYTALE_TOKEN_FD`;
* **the environment is exactly four variables** — `PATH`, `TERM`, the
  host-configured `CYTALE_ORIGIN`, and `CYTALE_TOKEN_FD`. Nothing a session sends
  is read into it: environment requests are refused at the request level, and
  `Session.Environ()` is never consulted. The origin is what makes R14 hold —
  the host sets it, the session cannot override it, and the child has no argv or
  environment channel through which a member could redirect a freshly minted
  token at a server of their choosing;
* **the working directory is set explicitly**, never inherited;
* the process is put in its own session with the PTY as its controlling terminal
  (job control), so ending a session kills the whole process tree.

### The token descriptor's framing

One JSON object per line, newline-terminated (NDJSON). The plan defers the
framing to implementation; this is the choice, and it is the client's contract.
**Two frame kinds, and nothing else is a frame:**

A live token:

```json
{"access_token":"…","token_type":"Bearer","expires_in":900,"username":"jordan","serial":1234,"issued_at":"2026-09-13T12:00:00Z","renewal":false}
```

* `access_token`, `token_type`, `expires_in`, `username` mirror the bridge's own
  response body field for field. There is no refresh-token field and there never
  will be (R9).
* `serial` is the certificate serial the token was minted against. It is **stable
  across a session's renewals**; the nonce the host sends the bridge is what
  changes per mint.
* `renewal` is absent on the first token and `true` on every replacement. A
  renewal replaces the live token; it is not a second identity.

The session end, and why:

```json
{"end":"max_session_duration"}
```

`end` carries the host's `ReasonCode` verbatim — the same spelling
`internal/session` names it and the same spelling the client's
`SESSION_END_REASONS` lists. This frame exists because a bare end-of-stream
cannot say *why*: without it a client can only report "the token path failed" for
an idle timeout, a duration bound, or an expired certificate, which is the one
thing R19a forbids. It is written **while the child is still running** and
**before the write end is closed**, because a frame written after either is a
frame that reaches nobody; the host then closes the wire end and gives the child
the teardown window to act on the frame before it is killed.

**Ordering.** The first token is written to the descriptor *before* the child
process is started, so it is already buffered when the client can first ask for
it. The suite asserts this deterministically: the child performs a **non-blocking**
read as its first action, so a token that had not been buffered yet would return
`EAGAIN` rather than simply blocking. At the other end the order is tokens, then
the `end` frame, then end-of-stream.

## The session-end vocabulary (R19a)

A host-decided ending is delivered **twice**, on two channels:

1. **on the client's descriptor**, as the `end` frame above, while the client is
   still running — this is what lets the client name the cause in its own
   message instead of inferring one from a bare close;
2. **on the SSH channel**, as the block below, written **after the child process
   exits** so it never contends with the client's own drawing on the same PTY.
   This is the member's authoritative copy, and for the endings that happen
   before a client process exists it is the only one.

The block is plain text — the host owns the vocabulary, the client owns the
drawing:

```
── session ended ──
Your certificate expired while this session was open. Issue a new one at
https://chat.example.com/#/settings/ssh and reconnect.
(reason: certificate_expired)
```

Every server-supplied string in that block (the bridge's own message and reason)
is stripped of control characters before it is written, because a message headed
for a terminal is exactly where an escape sequence would do damage (R26a).

| Code | Cause | Names the re-issue URL | On the descriptor |
| --- | --- | --- | --- |
| `client_exited` | the member quit the client cleanly (nothing is printed) | — | — |
| `client_failed` | the client exited non-zero | — | — |
| `client_start_failed` | the client process could not be started | — | — |
| `no_pty` | a session with no PTY (`ssh -T`) | — | — |
| `command_not_supported` | an exec request carrying a command | — | — |
| `identity_missing` | a session outside the verifier | — | — |
| `session_limit` | one of the three session caps | — | — |
| `bridge_unreachable` | the startup mint could not reach the bridge (fail closed: no client starts) | — | — |
| `bridge_refused` | the bridge declined the assertion; carries the bridge's own reason | yes | `{"end":"bridge_refused"}` |
| `certificate_expired` | the certificate's window closed before a renewal | yes | `{"end":"certificate_expired"}` |
| `credential_epoch_moved` | the bridge refused a renewal after a password reset or revoke-all-sessions | yes | `{"end":"credential_epoch_moved"}` |
| `token_path_failed` | the bridge was unreachable through the whole renewal window | yes | `{"end":"token_path_failed"}` |
| `max_session_duration` | the absolute session bound | — | `{"end":"max_session_duration"}` |
| `idle_timeout` | the idle bound | — | `{"end":"idle_timeout"}` |
| `connection_lost` | the connection disappeared (log only; there is nothing left to print on) | — | — |

**Which codes travel on the descriptor, and why.** The rule the code states
(`endFrameCode` in `internal/session`): a code travels when the **host decided to
end a session whose client is still running**, because that client's descriptor
reader is what turns the cause into a message. The rest do not, for one reason —
there is no live reader: the ending is the client's own exit or failure, or the
session was refused before a client process (and therefore a descriptor) existed,
or the connection that carried the member's terminal is gone. A startup
`bridge_refused` never travels for that reason even though a renewal-time
`bridge_refused` always does. The host-side suite asserts this list per reason
(`TestEndFrameVocabularyIsTheLiveClientRule`), over a real connection
(`TestTheRunningClientReceivesTheReasonForEveryHostDecidedEnding`), and the
client's `SESSION_END_REASONS` is the same list.

The bridge's own reason strings — `unknown_serial`, `certificate_expired`,
`principal_mismatch`, `fingerprint_mismatch`, `account_deleted`, `unverified`,
`credential_epoch_moved`, `replayed_assertion`, `stale_assertion` — are carried
through verbatim on the `(reason: …, bridge: …)` line.

## Refusals

| Refused | Why |
| --- | --- |
| a session with no PTY | the client is an interactive terminal client (R11) |
| an exec request carrying a command | the host runs one client, which takes no command |
| port forwarding (`direct-tcpip`, `forwarded-tcpip`, `tcpip-forward`) | (R11) |
| agent forwarding (`auth-agent-req@openssh.com`) | (R11) |
| X11 forwarding (`x11-req`) | (R11) |
| subsystems (`sftp`, …) | (R11) |
| environment requests (`env`) | the child's environment is host-built; accepting one and ignoring it would be a lie to the client |
| password and keyboard-interactive | the certificate is the login, not a factor (KTD1) |

Agent forwarding and environment requests are refused by this host's own request
filter rather than by a library default: the charm fork's session loop answers
both **true**, with no option to turn it off, so without the filter the request
would be accepted.

### The serial-0 trap (a harness that signs its own certificate)

`ssh-keygen -s` writes `Serial: 0` unless it is given `-z`, and this host refuses
a certificate whose serial is 0 (`auth.ParseIdentity`) — because the bridge looks
an issuance up *by serial*, and 0 is not an issuance. The confusing part is the
symptom: the certificate **authenticates**, and the session is then refused as
`identity_missing`, whose member-visible text is the same
`Permission denied (publickey)` a wrong login name produces. So a hand-rolled
test or an operator's manual signing session looks like a broken trust set or a
broken identity path, and neither is.

Sign with an explicit serial:

```
ssh-keygen -s "$CA" -I cytale -n "$USER" -V -1m:+24h -z 900001 member.pub
```

Production is not exposed to this: the signer uses `Cytale.Snowflake.next/0`, so
an issued certificate's serial is always non-zero. `apps/ssh-host/e2e/` and
`scripts/ssh-host-e2e.sh` both sign with explicit serials and carry this note.

## Boot assertions

`session.NewHost` asserts, before it listens, that:

* `ServerConfig.PublicKeyCallback` is the verifier itself — not a wrapper, and not
  nil;
* `Server.PublicKeyHandler`, `PasswordHandler` and `KeyboardInteractiveHandler`
  are all nil, and no password or keyboard-interactive callback is configured;
* the charm fork's fail-open condition cannot fire. The fork sets
  `NoClientAuth = true` — accepting every connection without authentication —
  when every handler and callback is nil, so the assertion mirrors that condition
  and refuses to start in it.

`CYTALE_SSH_HOST_CLIENT_ARGS` is host configuration only. Nothing a session sends
reaches that slice.

## Running the tests

```sh
cd apps/ssh-host
go test ./...          # the unit and real-handshake suites
go vet ./...
```

The suite includes real handshakes over a loopback listener: a certificate
authenticates, each rejection reason is refused, the token reaches the child's
descriptor before its first request, a renewal arrives before the previous token
expires, a credential-epoch change ends the session at the next renewal, every
host-decided ending pushes its reason down the descriptor and the running client
reads it, the child can open neither secret and inherits no open regular file,
and the caps and deadlines bound unauthenticated work. No test touches a real
bridge, a real CA, or a real deployment key: the fixtures are generated
in-process.

One of those tests drives the host's clock (`session.Config.Now`) instead of
waiting for a certificate to expire: the certificate is genuine and its window is
real, and moving the clock is what makes the renewal's refusal deterministic.
The clock is a seam, not a setting — it has no environment variable.

## Platform

The host targets unix. PTY allocation, the controlling-terminal setup, and the
process-group kill that ends a session's whole process tree are unix primitives,
and the deployment target is a Linux container (U17). Certificate verification,
the bridge client, and the token pipe are portable Go.

## Dependencies

Pinned as the plan specifies, and all three resolved:

| Module | Version |
| --- | --- |
| `charm.land/ssh` | v0.4.3 |
| `charm.land/wish/v2` | v2.0.4 (the `recover` middleware, for per-session panic containment) |
| `golang.org/x/crypto` | v0.57.0 |

`go mod tidy` raises one transitive dependency above the version
`charm.land/ssh` alone would pick: `github.com/pires/go-proxyproto` v0.12.0 →
v0.15.0, because `charm.land/wish/v2` v2.0.4 requires it. PROXY protocol support
is not enabled on this host.

## License

BSD-3-Clause, like the rest of the repository (see [`LICENSE`](../../LICENSE)).
Module path: `github.com/jrimmer/hrmny/apps/ssh-host`.
