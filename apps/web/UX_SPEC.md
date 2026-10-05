# Cytale Web — UX Specification (U18)

The reference for all web-client feature units (U19–U26). Layout and token
decisions here bind those units; measured values trace to the UX reference
corpus (`docs/research/2026-08-27-cytale-ux-reference-corpus-distillation.md`).

**Stack pins (binding):** Tailwind v4 via the `@theme` bridge over
`src/app/theme/tokens.ts` · Radix UI primitives skinned only by our tokens ·
Lexical + `@lexical/markdown` composer (U21) · WCAG 2.1 AA (axe + keyboard-nav
in every unit's states-first DoD).

---

## 1. Layout — the 4-region shell

Left to right (corpus §6.1, measured Discord geometry):

| Region | Width | Component | Content owner |
| --- | --- | --- | --- |
| Workspace rail | 72px | `WorkspaceRail.tsx` | U20+ (workspace icons) |
| Channel sidebar | 280px | `ChannelSidebar.tsx` | U20 (categories + channels) |
| Message pane | fluid | `AppShell` center | U21 (scrollback + composer) |
| Member list | 360px, collapsible | `MemberList.tsx` | U26 (people directory) |

- Escalation ladder per surface (≤1 level, corpus §4): rail and sidebar sit on
  `background`; the message pane is `surface-emphasized`; drawers/menus are
  `surface-strong`; `surface-selected` is reserved for persistent selection.
- The thread side-panel (U22) is **the same message-pane component rendered
  narrower** — a docked split at ~⅓ window width with the parent channel still
  visible (corpus §6.5). No fly-in sheet, no special treatment.

## 2. Responsive behavior (PWA, mobile width < 768px)

- **Workspace rail** folds behind a hamburger trigger in the topbar
  (`aria-label="Open navigation"`); content opens in a focus-trapped drawer.
- **Channel sidebar** becomes a slide-in drawer (Radix Dialog, `drawer`
  class): overlay + panel from the left, focus trapped, `Esc` closes.
- **Member list** becomes an overlay drawer from the right
  (`aria-label="Show member list"` trigger).
- The message pane never collapses; it is the mobile screen's body.

## 3. Theme

Dark-default. Tokens: primitive scales in `tokens.ts`, semantic roles in
`semantic.ts`, CSS bridge in `tokens.css` (`@theme` + `:root[data-theme]`).
The light theme is a future **pure semantic remap** — components never branch
on theme. Selection language: neutral pill (`bg-surface-selected`); color is
reserved for meaning (unread white-bar, mention red count, presence dots).

## 4. Thread side-panel behavior (U22 reference)

- Entry: "Open Thread" hover action on a message with a thread; or click a
  thread reply indicator. The panel docks right of the message pane.
- Panel contains ordinary scrollback, composer, and date dividers — identical
  components to the channel pane, narrower.
- Parent channel remains visible and live (new messages keep flowing).
- Thread unread tiers follow U12's follow-state model; per-thread unread
  badges appear in the panel header and in any threads-list destination.

## 5. Search bar placement (U24 reference)

- Discord-style **search bar in the channel sidebar header** (top of the
  sidebar, above categories), full sidebar width, `input` token well with
  `input-border`.
- `Ctrl+K` / `Cmd+K` focuses search from anywhere (quick channel switcher
  semantics); `Esc` blurs/closes results.
- Results open as an `surface-strong` dropdown pinned to the bar; each result
  is jump-to-message (U24: in-context jump, U12 threads jump into the panel).

## 6. Keyboard shortcuts (Discord-class)

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+K` | Quick switcher: focus channel search |
| `Alt+↑` / `Alt+↓` | Previous / next channel (unread-aware) |
| `Shift+Esc` | Mark channel as read (clear unread badge) |
| `Esc` | Close drawer/panel/search results, in priority order |
| `Ctrl/Cmd+Shift+M` | Toggle member list |
| `Tab` | Semantic order only: rail → sidebar → pane → members |

- Focus is **always visible** (`ring-focus` token, 2px, offset 2px).
- Every interactive element ≥ 40×40px hit area (corpus §4).
- Drawers/panels return focus to their trigger on close (Radix default).

## 7. Hover actions on messages (U21 reference)

React / Reply / Edit / Delete appear in a `surface-strong` toolbar pinned to
the message row's top-right corner on hover **and** on keyboard focus (the
toolbar is in tab order — hover is never the only path). Edit in place;
Delete confirms inline (no native dialogs).

### Action rows on messages (components plan U4 reference)

Bot-authored messages may carry Discord-style action rows (buttons and
string selects). They render at the **bottom of the message body** — below the
embeds and the attachments, directly above the reaction row (a message with
all four pins content → embeds → attachments → components → reactions). This
corrects the earlier text here ("directly under the content, above embeds",
called Discord's order): action rows are Discord's LAST body element, and the
inverted placement put a card's own buttons above it. See U4/R7 for the
record. Click states, all states-first:

- Buttons are real `<button type="button">`s with token-disciplined style
  mapping (styles 1–4 → accent / secondary / success / danger; never raw
  Discord colors); style-5 link buttons are http/https-only anchors
  (scheme re-checked at render; `javascript:`/`data:` render inert) and
  never POST. The string select follows the ReactionPicker keyboard
  contract (arrows / Enter / Escape, focus return; single-select v1).
- Every control and option carries a ≥40×40px hit area.
- Controls disable when: the component JSON says `disabled` (resolved
  card), a click on that control is pending (store-scoped by
  `(message_id, custom_id)` — survives virtualization remount), offline,
  the owning bot is gone from the roster, or the viewer is read-only
  (pre-disabled with an explanatory title — never enabled-buttons-that-403).
- Completion is the composed watch: the target message's flip (type 7) OR
  a new bot-authored message (type 4/followup); first signal wins, ~10s
  dismissable timeout otherwise, Retry on retryable errors only — 403
  permission-denied and dead-button copy are Dismiss-only.
- Card flips and the clicker's pending→resolved transition announce via a
  polite live region on the component block.

## 8. Markdown syntax (U21 composer)

Discord-flavored CommonMark via Lexical + `@lexical/markdown`:

`**bold**` · `*italic*` · `__underline__` · `~~strike~~` · `` `code` `` ·
```` ```lang blocks ``` ```` · `> quote` · `# H1–H3` headers · `- lists` ·
`[link](url)` · `||spoiler||` · `<@userId>` mentions (rendered from the
store, never raw).

Enter sends; Shift+Enter is a newline. Canonical CommonMark is the stored
form; rendering is derived, never re-parsed ad hoc.

## 9. States-first definition of done (all web units)

Every surface ships **all** of: loading (skeleton/progressbar), empty (named
empty-state with next-step hint), error (`role="alert"` with recovery copy),
offline (persistent `role="status"` banner), view-only (explicit note),
permission-denied (alert replacing content). Verified with axe (zero
violations) + keyboard walkthrough at desktop **and** mobile widths.

---

## 10. Integrations panel (U13 reference)

Standalone hash-routed surface at `#/integrations/:pane` — panes **bots** |
**webhooks** (workspace scope) and **Your agents** (user scope). It renders
as a full-screen Radix Dialog overlay above the shell (one escalation level,
`surface-emphasized`; Discord settings density is deliberately NOT the
reference). Entry: a rail button (beside Home, active-pill state while
open); on mobile the same entry also rides at the bottom of the hamburger
drawer. The surface absorbs into #19's settings shell when that lands — the
panel takes pane/route callbacks as props for exactly that reason.

- **Tab strip**: manual ARIA tablist (roving tabindex, ArrowLeft/Right
  cycle with automatic activation); Esc/✕ close returns focus to the entry.
- **Once-only token reveal** (bots + agents): the `cytbot_` credential
  appears ONLY in the create/regenerate modal — copy affordance with
  "Copied!" feedback, "shown once" copy, and the stated recovery path
  (regenerate mints a new credential; a dismissed modal never reopens).
  Regenerate confirms INLINE first ("This disconnects the bot immediately —
  its current token stops working.").
- **Webhook URLs are NOT once-only**: rows re-display the capability URL on
  every list read (manage-gated re-viewable, Discord parity) with a
  per-row Copy URL button.
- **Inline destructive confirms** (no native dialogs): revoke / regenerate /
  webhook-delete arm in place into consequence copy + Cancel/Confirm;
  focus moves to Cancel so the safe path is read first; Cancel (or Esc)
  leaves state untouched.
- **Agent restrictions**: mint/edit use PRESETS mapping 1:1 onto the wire
  `restrictions` payload — Unrestricted (`null`), Read-only
  (`{"actions":["read"]}`), Post-only (`{"actions":["post"]}`),
  Channel-scoped (`{"channels":[…]}`, channel picker, ≥1 enforced
  client-side). Unsaved edits make the pane DIRTY: pane switches and close
  are blocked behind an inline confirm-discard ("Keep editing" /
  "Discard and switch|close").
- **States-first mapping** (per pane): loading skeleton during list fetch ·
  named empty states with next-step hints ("No bots yet — create one with a
  name", peers for webhooks/agents) · error alert + retry · offline banner
  with destructive actions disabled · permission-denied alert replacing
  pane content for non-admins on the workspace panes (a 403 renders this
  state; there is no view-only variant by design — the agents pane is
  self-scoped and always accessible; unverified accounts get the
  ACCOUNT_UNVERIFIED alert there).
