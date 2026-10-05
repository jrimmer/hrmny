# Monitoring

What this document is for: **we ship the signals, you own the consumer.** There
is no way for this repository to guarantee that a monitoring stack exists, that
anything scrapes it, or that a human acts on an alert. What it *can* guarantee
is that the signals are exposed, the thresholds are written down, and the alert
rules are copy-pasteable. That is the whole of this page.

## The two URLs

| URL | What it answers | Use it for |
| --- | --- | --- |
| `GET /health` | **Liveness.** 200 once the node serves HTTP. Consults NOTHING. | Container restart policy. Do **not** alert on it — it reports `ok` while the database is gone. |
| `GET /health/ready` | **Readiness.** 200 when a member could actually read a message; **503** (with the failing check named in the body) when a dependency is down. | Uptime alerting. `scylla` is the check that exists today; more layer on as they earn their cost. |
| `GET /metrics` | **The scrape surface.** Prometheus text exposition of the app's own telemetry. | Scraping. |

Both health URLs are unauthenticated on purpose: a probe that needs a credential
fails the day the credential expires.

### `/metrics` is OFF until you turn it on

Set `CYTALE_METRICS_TOKEN` on the deploy host and the surface answers only with a
matching `Authorization: Bearer <token>`. **Leave it unset and the route is a
404** — fail-closed, deliberately: telemetry names workspaces and event classes,
so "no token" must mean *off*, never *public*.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: cytale
    scheme: https
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/cytale-scrape-token
    static_configs:
      - targets: ['chat.example.com']
```

## What the exposition contains

Every retained metric from `Cytale.Telemetry.Stats`, one family per metric, with
the aggregation as a label — the metric key already carries its unit, so the
name stays truthful:

```
# TYPE cytale_fanout_dispatch_ms gauge
cytale_fanout_dispatch_ms{stat="samples"} 41
cytale_fanout_dispatch_ms{stat="mean"} 3.2
cytale_fanout_dispatch_ms{stat="p99"} 9
cytale_fanout_dispatch_ms{stat="max"} 12
```

`cytale_fanout_dispatch_ms` is the fan-out dispatch latency: the time from a
publish reaching the workspace process to the send, over the retained sample
window. The same data has existed as JSON at `GET /admin/metrics` all along
(behind the operator gate, which no scraper can open) — this is that data, in
the format and behind the door a scraper speaks.

Two ring families time a message end to end. `cytale_message_post_ms` is the
native `POST /channels/{id}/messages` handler, accept to response.
`cytale_message_deliver_ms` is accept to the push onto each recipient's
socket, so it covers the write, the publish, the fan-out queue and that
socket's mailbox. A deliver p99 far above the post p99 points at the fan-out
or at slow recipients, not at the database.

Counter families ride the same exposition. `cytale_delivery_events_total{event}`
counts delivery failures that do not fail a request: `offline_append_dropped`
(a session-store shard was down when an event was buffered for a disconnected
session, which will full-sync), `publish_failed` (a message — a channel
message or a thread reply, from any send route — was stored but a step after
the write raised: its live publish, the channel pointer, or a thread reply's
follow and reply counters; the send still answered with the stored message) and `nonce_claim_failed` (a send went ahead without its
durable dedupe reservation). All three should sit at zero.

Another counter family is the message-mark outcomes: `cytale_marks_total{kind, state}`. `state` is `set`,
`cancelled` (by the member), `fired` or `missed`. The labels are the kind and
the outcome only, never who marked what. A `missed` count that climbs while
`fired` stays flat means the reminder sweeper is not keeping up, or is not
running.

## Three things this document cannot do for you

1. **Probe from off the box.** A checker running on the deploy host cannot report
   the deploy host being down, and the app cannot honestly report the health of
   the machine it is dying on. Uptime, cert expiry and disk therefore need a
   prober elsewhere — `blackbox_exporter` for the URL and the certificate,
   `node_exporter` for the host.
2. **Alert over the thing that is down.** If the alert path terminates on the same
   host, a host outage is silent. Whatever delivers the page has to live
   somewhere else.
3. **Know your numbers.** The thresholds in `monitoring-rules.yml` are **ours**,
   chosen from what this app's budget was designed around, not measured on your
   box. They are a starting point to tune, not a truth.

## Reference rules

`docs/monitoring-rules.yml` is a complete, copy-pasteable rule file: readiness
down, disk warn/page, certificate expiry, and fan-out p99 against its budget. It
assumes the exporters above are in place — the file says which target each rule
needs.
