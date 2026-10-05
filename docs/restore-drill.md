# Restore drill — the live-drill runbook

Purpose: prove, on the deployed instance, the full IN-APP backup → restore →
verify round trip (reframed 2026-09-14: the in-app round trip supersedes
the ops-snapshot framing; the docker-volume snapshot path in
[self-hosting.md](self-hosting.md) §Backups stays as LAST-RESORT DR only).

The drill's bar (from the ticket):

1. Take a backup in the app; record size + timestamp.
2. Restore it over the SAME instance (stage → validate →
   restart-into-restore-mode).
3. Verify: fresh sign-in; read a pre-backup message; SEARCH for it; fetch a
   pre-backup ATTACHMENT by hash as a fresh client.
4. Record wall-clock per step; note every surprise (those notes are the
   ticket's evidence).

The sequence below is the rehearsed one — a local dress rehearsal ran it
end-to-end on this Mac (throwaway ScyllaDB, own keyspace/config/attachments;
nothing shared with the dev instance) and every step passed; its timings and
corrections are in §5. Live-only differences are in §6.

## 0. Preconditions (check before touching anything)

- [ ] Operator account exists on the instance AND its account id is in the
      admin allowlist (the admin tier fails CLOSED when the allowlist is
      unset — 403 for everyone). `GET /api/v1/admin/backups` must answer
      200 for the operator's token before anything else runs.
      (LIVE CORRECTION 2026-09-19: when `/etc/cytale/config.json` exists,
      its `operator_user_ids` array is the EFFECTIVE allowlist and WINS over
      the `CYTALE_ADMIN_USER_IDS` env — file-wins-over-env applies. Check
      the file first; a temporary drill operator is granted by adding the
      id there and to the env, and revoked in BOTH after the drill.)
- [ ] **Durable backups dir — check it, no longer a manual migration.**
      compose.yaml now mounts a dedicated `backups` volume at `/app/backups`,
      the path the default `backups.dir` resolves to (hardening plan 1.5), so a
      default deploy survives `docker compose up -d`. VERIFY it before drilling
      rather than assuming: `docker compose config` must show
      `target: /app/backups` for the `cytale` service. Operators who override
      `backups.dir` in `/etc/cytale/config.json` (a boot-read deployment fact;
      the editor surface cannot change it) must mount their own path instead —
      a custom dir without its own volume has exactly the old problem.
      History: this used to be a MANDATORY pre-drill migration because there
      was no volume at all and the default landed in the container's writable
      layer, which every upgrade destroyed — while backups kept succeeding into
      the fresh directory, so the staleness alert never fired and the RPO was
      unbounded with green probes.
- [ ] Disk headroom ≥ 2× the archive size on the backups volume: restore
      STAGES A COPY (`<backups.dir>/staged/<new-id>.tar` + its extraction)
      before validating.
- [ ] Quiet hour announced (restore takes the whole instance down for
      validate → truncate → replay → verify; everyone is signed out of
      nothing — sessions survive — but the API is dark).
- [ ] `jq`, `curl`, `shasum`/`sha256sum` available where the client commands
      run; `docker compose exec` access for the trigger and any rescue.

Design facts the operator needs (all shipped code, rehearsed):

- The backup WRITER is the scheduler (the only writer). There is NO
  on-demand HTTP backup route — §2 gives the two operator paths to fire one
  now.
- The restore intake is a STAGED-PATH form, not an HTTP upload:
  `POST /api/v1/admin/backups/restore` with
  `{"path": "<archive path INSIDE the app container>", "confirm": "REPLACE-ALL-DATA"}`.
  Any other body → 400 naming the token; bad path → 404; validation
  failures → 422 naming EVERY failed check; live data untouched in every
  refusal case.
- On 202 the response returns FIRST (~26 ms); ~300 ms later the node calls
  `System.stop(0)`; compose's `restart: unless-stopped` brings the container
  back; the next boot sees the marker beside config.json
  (`/etc/cytale/restore-marker.json`), starts WITHOUT the HTTP endpoint and
  WITHOUT the backup scheduler, re-validates the staged archive, then
  TRUNCATES every app table, replays every row (prepared INSERTs), verifies
  per-table counts against the manifest, materialises the secrets (incl.
  `secret_key_base`, so sign-in and permalinks survive), triggers the search
  rebuild (the index is derived data, never archived), clears the marker,
  and only then adds the endpoint back.
- A FAILED boot-apply refuses to serve: node UP, NOT serving, loud
  (`RESTORE REFUSED` re-logged every 60s), marker annotated `failed`, staged
  archive intact. Rescue = read the marker, fix or `rm` it, restart to
  retry.
- **The archive's secrets are the `secrets.json` set only; env-only secrets are
  not in it.** The restore materialises `secrets.json` (incl. `secret_key_base`
  and the TURN/OIDC/mailer secrets), but the WEB PUSH VAPID pair
  (`CYTALE_VAPID_PRIVATE_KEY` / `CYTALE_VAPID_PUBLIC_KEY`) is read from the
  environment and never enters the archive. Carry it over by hand whenever a
  restore rebuilds the environment: a regenerated pair silently invalidates
  every existing push subscription (RFC 8292), and `cytale_push_enabled 1` after
  a restore proves push is ON, not that it is the SAME key the browsers enrolled
  against (self-hosting.md, "Web push").

## 1. Auth (operator sign-in)

```bash
BASE=https://<instance>            # the public origin
TOKEN=$(curl -sS -X POST $BASE/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"<operator>","password":"<password>"}' | jq -r .access_token)
```

Wall-clock the call. 401 stops the drill (credentials); 403 on §2 stops it
too (allowlist).

## 2. Take the backup (in-app) and record size + timestamp

Fire ONE of:

```bash
# (a) no-console fallback — drop the catch-up anchor; the next poll tick
#     (<=60s) sees no last-success and runs the job:
docker compose exec cytale rm /etc/cytale/backups/.scheduler-state.json
```

(LIVE CORRECTION 2026-09-19: the once-suggested console path `bin/cytale eval
'Cytale.Backups.Scheduler.run_now()'` does NOT work on the release — `eval`
does not boot the supervision tree, so the Scheduler GenServer is not there
to call (GenServer noproc). The catch-up anchor drop is the operator path;
measured live: state-file removed → archive complete in ~68s, the write
itself well under a second. `run_now/0` never overrides
`backups.enabled=false` — if nothing appears, check
`/etc/cytale/config.json`.)

Readiness: poll the list until the new id appears:

```bash
curl -sS $BASE/api/v1/admin/backups -H "authorization: Bearer $TOKEN" | jq '.backups[0]'
```

Record: `id`, `bytes`, `created_at`, and wall-clock from fire → listed.
(REHEARSAL CORRECTION: pick the archive you intend to restore BY ID — on a
fresh install the scheduler backs up immediately on first boot, so
`.backups[0]` can be a pre-seeding archive.)

Optional offsite copy while you are here:
`GET /api/v1/admin/backups/<id>/download` (operator-gated; the archive
carries LIVE CREDENTIALS, written 0600 — store any copy no more openly).

## 3. Restore over the same instance

The scheduler's archive is already in the container at
`<backups.dir>/<id>.tar` — use that path directly (no upload step exists;
fetching to a laptop and copying back via `docker compose cp` works but
buys nothing for a same-instance drill).

Optional extra evidence before firing: write one post-backup message — it
must be GONE after the restore (proves REPLACE-ALL, not merge).

```bash
curl -sS -X POST $BASE/api/v1/admin/backups/restore \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"/etc/cytale/backups/<id>.tar","confirm":"REPLACE-ALL-DATA"}' | jq .
```

Expect **202** + the staged summary. Poll through the outage:

```bash
until [ "$(curl -s -o /dev/null -w '%{http_code}' $BASE/health)" = 200 ]; do sleep 2; done
until [ "$(curl -s -o /dev/null -w '%{http_code}' $BASE/health/ready)" = 200 ]; do sleep 2; done
```

Record: POST→202, 202→connection-drop, drop→`/health` 200 (restore-mode
apply), `/health/ready` 200. If `/health` does not answer within your
expected window:

```bash
docker compose logs app | grep -a RESTORE
docker compose exec cytale cat /etc/cytale/restore-marker.json
```

## 4. Verification bar (every check a FRESH client)

```bash
# 4a. sign in fresh
curl -sS -X POST $BASE/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"<operator>","password":"<password>"}' | jq -r .access_token

# 4b. read the PRE-backup message by id (rows came back)
curl -sS $BASE/api/v1/channels/<channel_id>/messages/<message_id> \
  -H "authorization: Bearer $TOKEN" | jq -r .message.content   # contains the marker

# 4c. SEARCH for the marker (index restored or rebuild ran)
curl -sS "$BASE/api/v1/workspaces/<ws_id>/search" --get \
  --data-urlencode 'q=<marker-fragment>' -H "authorization: Bearer $TOKEN" | jq '.results | length'
#   empty? restore triggers the rebuild itself and the commit window is
#   <=2s: retry once, then the escape hatch:
#   POST /api/v1/admin/workspaces/<ws_id>/search/rebuild (202 + job id;
#   GET .../search/status is the drift check).

# 4d. fetch the attachment BY HASH as a fresh client (Cache-Control:
#     immutable notwithstanding — a fresh curl has no cache to hit)
curl -sS -D- -o /tmp/restored-blob.bin $BASE/api/v1/attachments/<hash>
shasum -a 256 /tmp/restored-blob.bin    # must equal <hash>
cmp /tmp/restored-blob.bin <the-original-upload>   # byte-identical
```

Also record: the post-backup message id (if planted) must now 404.

Wall-clock each check. A 4c miss with 4b present is the derived-index
escape hatch above; a 4d miss is a restore BUG (blobs are content-verified
twice: archive-side at validation, store-side at replay).

## 5. Timings — rehearsed (local dress rehearsal, this Mac)

Environment: throwaway ScyllaDB `cytale-drill-scylla` (image
scylladb/scylla:2026.2.6, `--developer-mode=1 --smp 2 --memory=800M
--overprovisioned=1 --tablets-mode-for-new-keyspaces=disabled`, 127.0.0.1:9043
ONLY) + a dev-mode server on :4001 with its own keyspace (`cytale_drill`),
config/secrets/marker dir, attachments dir and search index. Dataset: 1
account, 1 workspace, 1 channel, 2 messages (one carrying the attachment),
1 blob — the archive covered all 53 whitelisted tables, 19 rows.

| Step | Wall clock | Result |
| --- | --- | --- |
| sign-in (auth) | 0.08–0.09 s | 200 + tokens |
| seed: workspace / channel / message / upload / attach-message | 0.027 s each | 201s |
| backup job itself (53 tables, 19 rows, 51,712 bytes) | **0.167 s** | id `bk-20260919T024347Z-FxbOKCcu`, exported_at 02:43:48Z |
| catch-up trigger: state-file deleted → archive listed | ~100 s | bounded by the 60 s poll tick (deletion landed just after one) |
| `GET /admin/backups` list read | <10 ms | id/bytes/created_at correct |
| `GET /admin/backups/:id/download` | 0.002 s | 200; sha256 of download == on-disk archive |
| restore POST → 202 | **0.026 s** | staged summary: 53 tables / 19 rows |
| 202 → node fully down | 0.39 s | System.stop after the 300 ms response delay |
| node down → `/health` 200 (restore-mode boot + apply) | **3.5 s** | apply itself 1.55 s; the rest is VM/app boot (dev) |
| `/health/ready` 200 | +0.1 s | scylla check ok |
| verify: fresh sign-in | 0.082 s | 200 |
| verify: read pre-backup marker message | 0.039 s | 200, marker byte-exact |
| verify: search hit | 0.040 s | 1 hit, correct message id (rebuild had run in-restore) |
| verify: attachment fetch by hash | 0.031 s | 200; sha256 == name; byte-identical; `cache-control: public, max-age=31536000, immutable` |
| replace-semantics: post-backup row after restore | — | 404 (gone); channel holds exactly the 2 pre-backup rows; live `COUNT(*)` == manifest rows |

Rehearsal environment notes (for anyone re-running it — all corrections
found by the rehearsal are already folded into the steps above):

- The ticket's `--memory 1500m` container limit is BELOW ScyllaDB's
  documented headroom rule (~1.5 GB above seastar's `--memory=800M`): the
  node refused to boot (`insufficient physical memory`). **2500m works.**
- The Docker VM's `fs.aio-max-nr` (65536) is too small once several ScyllaDB
  containers share it: raise once per VM with
  `docker run --rm --privileged alpine sysctl -w fs.aio-max-nr=1048576`.
- Dev has no keyspace env override (`CYTALE_TEST_KEYSPACE` is :test-only);
  the rehearsal set `scylla_keyspace` before app start via
  `mix run --no-start boot.exs` (put_env, then `Mix.Task.rerun("phx.server")`).
- Dev has no process to answer restore-mode's `System.stop(0)` — the
  rehearsal ran the server under a `while`-loop wrapper as the stand-in for
  compose's `restart: unless-stopped` (this is §6's live-vs-local point).

## 6. Live vs local (the only expected differences)

- Restart-into-restore-mode: live = compose restarts the container and the
  release re-execs into restore mode; local = the shell loop restarted the
  VM. Everything after the restart is identical code.
- Down→up wall clock is dominated live by the release boot + the archive's
  real size (validation streams + re-hashes every part; replay is one
  prepared INSERT per row): the 3.5 s rehearsal number is a floor, not an
  estimate. MEASURED LIVE 2026-09-19 (935 KB, 1,843 rows, 53 tables):
  restore POST 202 in <1 s, container down → healthy in ~80 s; through the
  front proxy the 502 window read longer (~2.5–4 min) than the container's
  own health — probe /health on the BOX, not through Caddy, when timing
  the window.
- Live has no mailer/dev-mailbox step (operator credentials are real and
  verified); the rehearsal verified via the dev mailbox file.
- Live archive path is `/etc/cytale/backups/<id>.tar` (after §0's durable
  backups.dir precondition); the rehearsal's was `/tmp/cytale-drill/backups/…`.

## 7. Findings the drill surfaced (rehearsal evidence, reported not fixed)

1. **compose has no backups volume (safety).** Archives land in the app
   container's writable layer and die on every `up -d` recreate; restore's
   staged copy dies with them. §0's precondition (backups.dir on the
   server_config volume) is the drill-blocking fix; a `backups:` named
   volume in compose is the durable one. (The dev server on this Mac has
   the same default — `apps/server/backups/` already holds two in-tree
   archives.)
2. **No on-demand backup route (operations).** `POST /admin/backups/run`
   (or similar) would remove the console/state-file workaround from §2;
   today the scheduler is the only writer and `run_now/0` has no HTTP
   surface.
3. **Restore intake is staged-path by design** — "upload" in the drill plan
   means "name the on-host path"; an in-request upload would buffer a
   restore-sized body in the VM (deliberate). Fine, but the operator needs
   `docker compose exec` access even for a pure in-app drill.
4. **Fresh-install immediate backup can confuse archive selection** — the
   scheduler backs up on first boot (no state file), so a list's
   `.backups[0]` may predate the data you meant to protect. Select by
   recorded id (§2 correction).
5. Verified NON-issue while rehearsing: `Restore`'s
   `:erl_tar.table(..., [:compressed])` against the writer's UNCOMPRESSED
   tar — OTP accepts it; staging + validation + replay all passed.
