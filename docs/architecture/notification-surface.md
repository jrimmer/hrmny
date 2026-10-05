# The notification surface: exceptions, not inventory

**Status:** design (2026-09-15). The tree shipped on `#/settings/notifications` is
the first step of this document, not a substitute for it. Read it as the answer
to one question the maintainers asked twice: *"I'd still like a general rethink of the
notifications UI as even a tree gets cumbersome over time."*

**Companion reading:** `docs/architecture/product-invariants.md` (never silently
change the UI · one read state · search is workspace-scoped), and the 2026-09-14
survey of Slack/Discord complaints, whose headline is that both platforms'
chronic complaints are **design problems that bite at 30 people** — our shape.

---

## The problem with the tree, stated precisely

The current surface is a tree of the member's **workspaces and channels**, each
row showing its resolved level and the layer that decided it. Collapsed
workspaces and a per-workspace exception count made it readable; neither makes
it *stay* readable, and the reason is structural:

> The tree's size is **O(workspaces × channels)**. It grows with how many
> channels other people created, not with how many decisions the member made.

A member with nine workspaces sees nine rows they never touched, and opening one
shows every channel in it — overwhelmingly rows on which they have expressed no
opinion. That is an **inventory**. An inventory asks you to read it to find your
own decisions inside it, and it gets worse every time someone else makes a
channel. Discord's version of this is five silent layers; ours is a tree; both
fail the same way, which is that the member cannot see *what they decided*
without also reading *what they did not*.

The design below is one idea applied twice: **the surface shows exceptions, and
exceptions are created where the decision is actually made.**

## The idea

1. **The member's default is one row, and it is always visible.** "Notify me
   about" with three answers — `Everything`, `Mentions and DMs` (the default),
   `Nothing`. This is the only row that exists without the member doing
   anything.
2. **Everything below it is an exception the member created, and nothing else
   appears.** A row's existence is the statement "I decided something here."
   The list's size is therefore O(decisions), not O(channels).
3. **Exceptions are mostly created at the point of use**, not in settings:
   the channel's own ⋯ menu and a thread's carry a **Notifications** item with
   the same three answers plus `Use the default`. That is where the decision is
   actually made — you are looking at the noisy channel when you decide to
   quiet it. Settings remains the place to *review and undo*.
4. **The resolved answer is still always available, and it is still explained.**
   Any channel's Notifications menu states the effective level and the layer
   that decided it ("Mentions and DMs — from this workspace"), which is the
   property that makes this product different from Discord's silent cascade.
   The full resolved tree does not vanish; it becomes the **diagnostic** view
   behind a "Show what I'm inheriting" disclosure rather than the default one.

The result: a member who has decided nothing sees one row. A member who muted
three channels sees one row and three lines. Neither view degrades as their
workspaces grow, and the *explanation* survives — which is the thing that must
not be traded away to get there.

## What must not be lost (the properties already paid for)

These exist today and the redesign is constrained by them:

- **The explanation, not just the value.** Every row that shows a level also
  says which layer decided it and whether the member overrode it. This is the
  answer to the missed-notification problem the whole feature was opened for.
- **One read state.** No second watermark, anywhere, for any reason — including
  for notifications. (Product invariant; Discord's thread model is the
  counter-example.)
- **Delivery is not content.** "What reaches me" (levels) and "where it is
  delivered" (this browser, that phone, the desktop shell) are different
  questions and stay different controls. Slack's 2025 rebuild is the evidence:
  they merged four incompatible preference systems and still had to decouple
  content from delivery.
- **Never silently change the UI.** This redesign ships as a *visible* switch,
  the way the message hover toolbar's placement did, not as a surprise on
  reload.
- **Nothing is a dead control.** A row that cannot take effect must say why
  instead of appearing inert (the delivery states already model this).

## The table-stakes set this closes

The survey named the one gap that lands inside this design: **per-channel
three-state + DND, synced across clients.** Today the levels are
`all` / `mentions` / `mute` and the storage is already the right shape — one
preference table keyed by scope and entity, resolved by one walk. Two additions
complete the set:

- **DND is a state, not a channel property.** "Quiet for the next two hours" is
  about the *member*, not about any room, and needs a duration and an explicit
  end. Quiet hours as a schedule is a separate feature; an ad-hoc DND is this surface's.
- **A mute must suppress `@everyone` and `@here`, visibly.** Discord's trap is
  that muting a server does not stop a mass mention unless the member also finds
  a second, separately-stored switch. One control, one meaning.

## What the surface becomes, concretely

```
Notifications                                    ← the same #/settings/notifications

  Notify me about            [ Everything | Mentions and DMs ✓ | Nothing ]
  Mentions and DMs — this applies everywhere you have not said otherwise.

  Quiet now                  [ Quiet for ▾ 30m / 2h / 8h / until tomorrow ]  off

  ───────────────────────────────────────────────────────────────────────
  You have decided about 4 places                             [Show all ▸]

  #general          · Cytale            Everything      → Use the default
  #releases         · Cytale            Nothing         → Use the default
  @helper-bot       · Direct message    Everything      → Use the default
  Architecture      · thread in #eng    Mentions        → Use the default

  [ Show what I'm inheriting ▾ ]      ← the resolved tree, on request
```

- The four exception lines are exactly the member's four decisions. Two
  workspaces and forty channels they never touched appear nowhere.
- `→ Use the default` is the only destructive-looking action, and it restores
  inheritance rather than setting a level — the distinction the data model
  already makes (`clear/3` versus `set_level/4`) and which "mute" as a value
  cannot express.
- The diagnostic disclosure renders today's tree verbatim. It is the audit
  view, and the honest answer to "why am I not being told about this?".

**Point of use** — the channel ⋯ menu and the thread header gain the same three
answers with the resolved line above them. The settings surface is where a
member goes to *reconsider*; the point of use is where they *decide*.

## What this deliberately does not do

- **No per-thread levels as a headline feature.** The model supports thread
  scope, and threads are where noise concentrates, but a thread is a temporary
  object and a stored exception on it needs an expiry story first. Threads
  inherit their channel until that story exists.
- **No notification-category zoo.** No per-event-class toggles (reactions,
  joins, calls-as-separate-switches). Discord's five layers are what happens
  when every event class gets a switch; the survey's "notification fatigue" is
  the result. Calls already have their own ring mute, which is a call control
  rather than a notification preference, and it stays there.
- **No digest/batching UI.** Batching is a delivery decision the server can make
  without the member configuring it; exposing it as a control adds a knob whose
  right answer nobody knows.
- **No cross-client sync indicators.** The preferences are server-side and
  synced by construction; a "synced ✓" badge would be a claim about a mechanism
  rather than information.

## Build shape (when this is picked up)

1. **The exceptions ledger** — `GET /users/@me/notification-exceptions`
   (essentially `Preferences.all/1` with each entity resolved to a name and a
   scope label), and the section re-rendered as default + exceptions +
   diagnostic disclosure. The tree survives inside the disclosure, unchanged.
2. **Point of use** — the Notifications item in the channel ⋯ menu and the
   thread header, sharing one component with the section's rows, writing the
   same three-level preference through the existing endpoint.
3. **DND** — a member-scoped quiet state with a duration and an explicit end,
   consulted by the policy ahead of every level (a DND that a level could
   override would be the Discord layering mistake again).
4. **Mute breadth** — make `mute` suppress mass mentions and say so in the row's
   wording, with a test that a muted channel does not notify on `@everyone`.

**The original framing, kept verbatim so the intent survives:**
*"Notification management's cumbersome with channels listed aligned with
workspaces. Rethink the UI, please. At the very least tree the channels under
the workspace and start with workspaces collapsed. I'd still like a general
rethink of the notifications UI as even a tree gets cumbersome over time."*
The tree is step two of three; this document is step three.
