# Product invariants

Three rules this product holds deliberately. They are written down because each
is cheap to keep now and expensive to re-litigate after a redesign — every one of
them is a thing Slack or Discord got wrong at some point and could not cheaply
undo.

Sources for the "they got it wrong" halves are the platform surveys that produced
this file (Discord's own docs and blog, Slack's engineering blog and help docs,
plus community and press sources). Where a claim comes from a vendor's marketing
rather than their documentation, it is marked as such.

## 1. Never silently change the UI

**The rule.** A surface changes when its users ask for it, or with an opt-out and
a stated reason. No remote-config rollout that rearranges a surface under someone
mid-task, and no redesign whose only announcement is that it happened.

**Why.** Discord shipped a client redesign to one global client and reversed the
dark-theme part under pressure; Slack merged channels, DMs and apps into a single
"Home" with no opt-out and lost the spatial separation people navigated by. Both
are scale-driven decisions (one client for a heterogeneous userbase) that read to
a member as "the thing I knew is gone".

**How it is held.** UI changes come with a screenshot of the claimed state
(1x and, for anything pixel-sensitive, 4x), and the layout contracts are asserted
rather than described — the band gate (`apps/web/e2e/responsive-matrix.live.spec.ts`)
pins what each width must do, so a change that quietly breaks one band fails
before it ships.

## 2. One read state

**The rule.** A message has exactly one notion of "read" per member. Anything
that looks like unread state is derived from that same watermark — never a second
tracker with its own rules.

**Why.** Discord threads track explicit membership and clients compute read state
from their own thread-member record, so a thread carries a **second** read state
alongside the channel's. The visible consequence is the complaint users make most
about threads: as Discord's docs put it, the parent channel shows a count rather
than content, and you must have joined a thread to be notified of it. The count is
the price of the second tracker.

**How it is held.** `last_read_id` is the single watermark (inclusive), unread
badges and the in-pane "NEW" rule derive from it, and thread badges are a *view*
of it rather than a competing record. Known divergence to preserve rather than
"fix": the badge and the divider can disagree because the divider needs a
client-side slice the read-ack clears — that is a capture-timing problem to solve
where the ack is, not a reason to add a second watermark.

## 3. Search is workspace-scoped

**The rule.** The index is per workspace. There is no cross-workspace search, and
that is a product position, not a limitation to be quietly closed later.

**Why.** Discord shards its search index per guild — deliberately, "so that we
could store all a guild's messages together for fast querying" — which makes
cross-server search structurally impossible and is why their knowledge is
described, by their own engineers, as at risk of being locked away. We inherited
the same shape by building per-workspace indexes. That is the right trade for a
product whose members join a workspace to work in it, but it must be *chosen*: the
moment someone asks "why can't I search everything", the answer is this file, not
a re-architecture.

**How it is held.** The index writer is per workspace (`Search.IndexWriter`), the
admin surface is per workspace, and the search drift check reports per workspace. If
cross-workspace search is ever wanted, that is a new product decision with the
costs named here — not a bug fix.

## The compat wire asks Discord for nothing

Machine-credential (and human) avatars are served on the NATIVE surface only —
`avatar_url` in the REST row, the roster, and the web UI. The compat user
object's `avatar` field is **always null** (product decision, 2026-09-16: "we ask for
nothing").

Discord's wire carries a content HASH that clients resolve against Discord's
CDN (`cdn.discordapp.com/avatars/...`) — a host hardcoded in every Discord
library, where Cytale's images do not and will not live. Stuffing anything
else into the field (a URL, a hash of ours) produces a broken image in every
client, every render. Null makes the CLIENT fall back to its own default —
its choice, on its infrastructure, not ours. If Discord changes what it does
with a null, that is its prerogative; we neither ask nor capitalize. This is
a standing invariant, not a gap: do not "fix" the null.

## Things that look like invariants and are not

* **"Channels must be cheap to create."** True for Discord, where unbounded free
  channels plus a fixed pool of conversation produces the "50 channels, 15
  members" first screen that kills week-one retention. Our channel creation is
  admin-gated, so the sprawl has to be *chosen*; keep that, and treat categories
  as the answer to growth rather than more channels.
* **"Threads are the problem."** Threads are fine; the second read state and the
  hidden entry point are the problems. Ours has one watermark, a seed-message
  indicator, and a rail tab — keep the entry points visible and the model stays
  sound.
* **"Enterprise features are table stakes."** They are enterprise-driven and would
  be pure cost for a single team: legal holds, DLP/eDiscovery, residency, custom
  RBAC, 20-role matrices, marketplace directories, plan-gated history. The last is
  worth remembering as the anti-goal: Slack permanently deleted data older than a
  year on free plans from 2024, and upgrading does not bring it back.
