/**
 * @cytale/web — AppShell, the 4-region Discord-base layout (U18).
 *
 * Regions, left to right (corpus §6.1 — measured Discord geometry):
 *
 *   [72px workspace rail][280px channel sidebar][fluid message pane][360px member list]
 *
 * Responsive contract — three bands owned by `useShellBand` (the single source
 * of truth; the CSS is written to match, so never re-test the width here):
 *
 *   phone (< 768px)
 *   - a fixed-height MobileTopbar becomes the shell's only chrome: ☰ + title
 *     + join-voice + 👥 as constrained 44×44 controls (title/join-voice in U2),
 *   - the workspace rail unmounts — its content folds into the navigation
 *     drawer's workspace strip above the channel list,
 *   - the channel sidebar becomes a slide-in drawer (Radix Dialog, focus-trapped),
 *   - the member list becomes an overlay (Radix AlertDialog semantics via dialog),
 *   and the panes render only when opened.
 *
 *   tablet (768–1279px)
 *   - rail + sidebar + pane in ONE row, full height; no topbar (the sidebar is
 *     visible, so navigation needs no drawer),
 *   - the members rail is NOT rendered: `shell.css` has no fourth grid track
 *     below 1280px, and rendering the aside anyway put it in the shell's second
 *     row — a 72px member strip with the left cluster and pane robbed of their
 *     height (the #86 defect: 44% of an 834×1210 screen abandoned). Members
 *     are reached from the pane header instead, and the list REPLACES the pane
 *     (`AuthenticatedApp` owns that swap; this shell owns the desktop rail).
 *
 *   desktop (≥ 1280px)
 *   - all four regions render statically, each column independently scrollable.
 *
 * States-first DoD (per unit contract): the shell models loading / empty /
 * error / offline / view-only / permission-denied as first-class props so
 * every consumer (U19+ pages) inherits the states discipline. Each state is
 * announced accessibly (progressbar / status / alert roles).
 *
 * Geometry is enforced by CSS custom properties (--shell-rail etc.) from
 * tokens.css conventions; jsdom tests assert structure + contracts, not px.
 */
import '../theme/tokens.css';
import '../theme/shell.css';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useShellBand } from './useShellBand.js';
import { RailPane } from './RailPane.js';
import { RAIL_TITLES, RailIcons } from './RailIcons.js';
import type { RailMode } from './RailIcons.js';
import { MobileTopbar } from './MobileTopbar.js';
import { applyReduceMotion, readReduceMotion } from '../../features/settings/AppearanceSection.js';
import { applyStyle, applyTheme, readStyle, readTheme } from '../../app/theme/prefs.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '../../components/shadcn/dialog.js';
import { InteractionModalHost } from '../../features/interactions/InteractionModalHost.js';

/**
 * Column resize bounds (px). Minimums keep a column's UI usable — the
 * sidebar must still show its header + rows, the members rail its avatar
 * rows — maximums keep the conversation pane honest. Values persist per
 * browser (localStorage), not per account.
 *
 * The sidebar floor is set by the channel ROW, not by taste: list padding
 * (8+8) + row padding (8+8) + the `#` prefix (~18) + the row gap (8) + the
 * context gear's reserved 40px column, leaving ~80px of channel name before
 * it ellipsises. Owner direction 2026-09-12: the column was wider than it
 * needed to be and could not be narrowed to a name-plus-gear row. Note the
 * identity panel gets tight down here (its toolbar is fixed-width) — the name
 * truncates rather than the row breaking.
 */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const MEMBERS_MIN = 220;
const MEMBERS_MAX = 480;
/**
 * Defaults match the measured Discord reference (`docs/research/screenshots/
 * 2026-09-12-responsive-matrix` + the owner's iPad captures): its sidebar
 * measures 259px landscape / 299px portrait, so 280 was wider than the
 * reference and wider than it needed to be.
 */
const SIDEBAR_DEFAULT = 240;
const MEMBERS_DEFAULT = 360;
const RESIZE_STEP = 16;

/** Stable no-op so an omitted tablet close handler can't re-render the pane. */
const noop = () => {};

function readWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // storage unavailable — widths simply don't persist
  }
}

export interface AppShellProps {
  /** Left vertical workspace switcher rail (U18 static; U20+ fills it). */
  workspaceRail: ReactNode;
  /** Category + channel list (U20). */
  channelSidebar: ReactNode;
  /** Center conversation pane (U21). */
  messagePane: ReactNode;
  /** Right member directory rail (U26); collapsible. */
  railContent: ReactNode;

  // -- states-first surface ---------------------------------------------------

  /** True while bootstrapping: skeleton shell + announced progressbar. */
  loading?: boolean;
  /** Sidebar reports no channels — render the empty-state hint. */
  channelSidebarEmpty?: boolean;
  /** Sidebar reports a load failure — render an alert with the message. */
  channelSidebarError?: string;
  /** Gateway offline (U15) — render a persistent status banner. */
  offline?: boolean;
  /** Current user lacks send permissions in this channel. */
  viewOnly?: boolean;
  /** Permission-denied detail for the pane (U6/U7 seam). */
  permissionDenied?: string;

  /** Mobile-only: members overlay trigger visibility. */
  memberListCollapsible?: boolean;
  /**
   * Which mode the 4th column shows, or null when it is HIDDEN — which is now
   * the default on every surface (owner direction 2026-09-12). The host owns
   * this because the icons live in chrome the host composes: the pane header on
   * a channel, a 48px band on surfaces with no header.
   *
   * At desktop a non-null mode opens the fourth grid TRACK; at tablet there is
   * no track, so the same mode REPLACES the pane. Before this, "is the column
   * shown" and "what is in it" shared one flag, and Home could only opt out of
   * the member list by losing Call log and Threads with it (#105).
   */
  railMode?: RailMode | null;
  /**
   * Toggles the column: the SAME mode closes it, a different one replaces it.
   * Owned by the host so that rule lives in one place, not per control.
   */
  onRailSelect?: (mode: RailMode) => void;
  /**
   * Mobile-only extra navigation pinned at the bottom of the hamburger
   * drawer (U13: the integrations entry rides here so it stays reachable
   * at mobile width). Clicks inside close the drawer.
   */
  drawerFooter?: ReactNode;
  /**
   * Bottom-left identity panel (UserPanel) — the left cluster's column-2
   * footer, i.e. it sits inside the channel sidebar's column only (the rail
   * ends above it in its own footer: `railFooter`). Mobile rides the drawer
   * above `drawerFooter`.
   */
  userPanel?: ReactNode;
  /**
   * Desktop-only footer pinned under the workspace rail (column 1) — the
   * build identity badge. The rail's own surface continues behind it so the
   * column reads as one strip to the bottom edge.
   */
  railFooter?: ReactNode;
  /**
   * Hide the members region entirely (Home owns the full remaining width —
   * its dashboard replaces the member rail the way it replaces the pane).
   * Drops the fourth grid track and the mobile members trigger.
   */
  railHidden?: boolean;
  /**
   * The rail modes the current surface offers (every icon set the shell
   * renders — the column header, the tablet pane, the phone topbar and
   * drawer); all three when omitted. Home passes Call log + Threads.
   */
  railModes?: readonly RailMode[];
  /**
   * MobileTopbar center title — workspace/channel name (U1 accepts the
   * slot; U2 fills it properly). Empty/omitted renders an empty slot.
   */
  mobileTitle?: string;
  /**
   * Muted sigil rendered before the mobile title (`#` channel / `@` DM),
   * aria-hidden — the desktop pane-header idiom. Null/omitted renders none.
   */
  mobileTitleSigil?: string | null;
  /**
   * MobileTopbar nav trigger face (2026-09-18): the active workspace's rail
   * icon replaces the ☰ glyph. Omitted (no active workspace) falls back to ☰.
   * The Dialog semantics around it are unchanged — only the glyph changed.
   */
  mobileNavIcon?: ReactNode;
  /**
   * MobileTopbar join-voice control (U2): a TopbarCallAction rendered
   * beside the members trigger. Desktop ignores it (the pane header's call
   * affordances are the only ones there).
   */
  mobileCallAction?: ReactNode;
}

/**
 * Region landmarks. Keyboard order follows visual order (rail → sidebar →
 * pane → members); each region is a named landmark so Ctrl+K-style navigation
 * (U21) and screen readers can address them directly.
 */
export function AppShell({
  workspaceRail,
  channelSidebar,
  messagePane,
  railContent,
  loading = false,
  channelSidebarEmpty = false,
  channelSidebarError,
  offline = false,
  viewOnly = false,
  permissionDenied,
  memberListCollapsible = true,
  railMode = null,
  onRailSelect = noop,
  drawerFooter,
  userPanel,
  railFooter,
  railHidden = false,
  railModes,
  mobileTitle,
  mobileTitleSigil,
  mobileNavIcon,
  mobileCallAction,
}: AppShellProps) {
  // The band contract lives in one hook so the JS branches and the CSS
  // breakpoints cannot disagree (the 768–1279px defect was exactly that
  // disagreement — see useShellBand).
  const band = useShellBand();
  const isMobile = band === 'phone';
  const isTablet = band === 'tablet';
  const isDesktop = band === 'desktop';
  /** The 4th column is open in some mode. One value, two questions answered
      separately: `railMode` says WHICH, this says WHETHER. */
  const railOpen = railMode !== null;
  const [navOpen, setNavOpen] = useState(false);
  /*
   * Phone: the side drawer opens ONLY on a tap of its own icons.
   *
   * `railMode` is the column's mode, and it outlives band changes by design
   * (the host starts it on Members at desktop and never resets it on a
   * resize). At phone that same value used to BE the drawer's open state — so
   * a window narrowed from desktop, or any mode remembered from a wider band,
   * came up as an open modal drawer that covered the topbar and made the rest
   * of the shell inert, with nobody having asked for it (live suite
   * 2026-09-29: the Members dialog intercepting every topbar tap).
   *
   * `drawerArmed` is that missing "the reader asked" bit. It is false whenever
   * the phone band is entered (mount or resize) and set by a topbar-icon tap;
   * until then the drawer is closed and the icons show nothing pressed — a
   * modal must never be a default. The toggle contract itself is unchanged
   * and still has one implementation (`onRailSelect`): the first tap on the
   * mode that is already set opens it rather than clearing it, which is what
   * the tap means from where the reader stands.
   */
  const [drawerArmed, setDrawerArmed] = useState(false);
  useEffect(() => {
    if (!isMobile) setDrawerArmed(false);
  }, [isMobile]);
  const drawerMode = isMobile && drawerArmed ? railMode : null;
  const selectDrawerMode = useCallback(
    (mode: RailMode) => {
      if (!drawerArmed) {
        setDrawerArmed(true);
        if (railMode !== mode) onRailSelect(mode);
        return;
      }
      onRailSelect(mode);
    },
    [drawerArmed, railMode, onRailSelect],
  );

  // Column widths: pointer-drag on the boundary handles (or Arrow keys on
  // the separators) resize the sidebar and members rail in place; the pane
  // flexes. localStorage persistence is per-browser.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readWidth('cytale.shell.sidebar', SIDEBAR_DEFAULT),
  );
  const [membersWidth, setMembersWidth] = useState(() =>
    readWidth('cytale.shell.members', MEMBERS_DEFAULT),
  );

  const clampSidebar = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
  const clampMembers = (w: number) => Math.min(MEMBERS_MAX, Math.max(MEMBERS_MIN, w));

  const startColumnDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    startWidth: number,
    direction: 1 | -1,
    clampWidth: (w: number) => number,
    apply: (w: number) => void,
    commit: (w: number) => void,
  ) => {
    e.preventDefault();
    const startX = e.clientX;
    let last = startWidth;
    const onMove = (ev: PointerEvent) => {
      last = clampWidth(startWidth + (ev.clientX - startX) * direction);
      apply(last);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      commit(last);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const nudgeSidebar = (delta: number) => setSidebarWidth((w) => clampSidebar(w + delta));
  const nudgeMembers = (delta: number) => setMembersWidth((w) => clampMembers(w + delta));
  const onSepKeyDown = (
    e: React.KeyboardEvent<HTMLDivElement>,
    nudge: (delta: number) => void,
  ) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nudge(-RESIZE_STEP);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      nudge(RESIZE_STEP);
    }
  };

  // #151: both theme axes are owned by prefs.ts (storage + system
  // preference). boot-theme.js already resolved them pre-paint; this
  // re-applies the same values after hydration so a stale attribute can
  // never survive, and the Appearance section can flip either axis live.
  useEffect(() => {
    applyTheme(readTheme());
    applyStyle(readStyle());
    // Reduce motion (settings → Appearance owns the toggle): apply the
    // stored per-browser preference at boot so saved sessions start calm.
    applyReduceMotion(readReduceMotion());
  }, []);

  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);

  const sidebar = (
    <>
      {channelSidebarError ? (
        <div role="alert" data-testid="channel-sidebar-error">
          {channelSidebarError}
        </div>
      ) : null}
      {/* The sidebar stays mounted in the empty/error states — its server
          header (menu + create actions) is the way OUT of both states. The
          hint renders beneath it. */}
      {channelSidebar}
      {channelSidebarEmpty ? (
        <div data-testid="channel-sidebar-empty">
          <p>No channels yet</p>
          <p>Create the first channel with the ＋ above.</p>
        </div>
      ) : null}
    </>
  );

  return (
    <div
      data-testid="app-shell"
      data-state={loading ? 'loading' : offline ? 'offline' : 'ready'}
      data-view-only={viewOnly || undefined}
      className={
        'shell' + (railOpen ? ' shell--rail-open' : '') + (railHidden ? ' shell--no-members' : '')
      }
      style={
        {
          '--shell-sidebar': `${sidebarWidth}px`,
          '--shell-members': `${membersWidth}px`,
        } as React.CSSProperties
      }
    >
      {loading ? (
        <div role="progressbar" aria-busy="true" aria-label="Loading workspace">
          <span data-testid="shell-skeleton">Loading…</span>
        </div>
      ) : null}

      {offline ? (
        <div role="status" data-testid="offline-banner">
          You are offline — reconnecting. Messages will sync when the connection returns.
        </div>
      ) : null}

      {isMobile ? (
        /* Mobile shell chrome v2 (U1, KTD1): the MobileTopbar is the shell's
           ONLY mobile chrome — ☰ + title + 👥 as constrained 44×44 controls.
           The Dialog compositions are passed as slots so their trigger
           buttons render inside the bar (never grid-stretched direct shell
           children — the B1 defect), while Radix drawer semantics stay
           exactly as they were. The workspace rail is GONE at mobile (B2):
           its content folds into the drawer's workspace strip below. */
        <MobileTopbar
          title={mobileTitle}
          titleSigil={mobileTitleSigil}
          callAction={mobileCallAction}
          navTrigger={
            <Dialog open={navOpen} onOpenChange={setNavOpen}>
              <DialogTrigger aria-label="Open navigation" className="mobile-topbar-action">
                {mobileNavIcon ? <span className="mobile-topbar-ws">{mobileNavIcon}</span> : '☰'}
              </DialogTrigger>
              <DialogContent
                  showCloseButton={false}
                  overlayClassName="drawer-overlay"
                  aria-label="Channels"
                  className="drawer"
                  onClick={(e) => {
                    // U5: the settings surfaces' mobile entries — the user
                    // panel's gear and the workspace menu's Workspace
                    // Settings item — open a surface that lives full-width
                    // in the PANE, so the drawer closes on their activation
                    // (the workspace strip's select-closes idiom); the open
                    // drawer would otherwise cover what they just opened.
                    // Everything else stays drawer-hosted (presence picker,
                    // transport, channel rows).
                    const target = e.target as HTMLElement;
                    // Feature content marks itself with data-drawer-close —
                    // the shell never reaches into feature testids.
                    if (target.closest('[data-drawer-close]')) {
                      setNavOpen(false);
                    }
                  }}
                >
                  {/* U6 (m1): the drawer header row — title left, ✕ top-right
                      (the thread-sheet/call-sheet header idiom). The old
                      absolute placement keyed on `button[data-state]`, which
                      Radix's Dialog.Close never carries, so the ✕ fell into
                      the column flow stretched full-width with a centered
                      glyph and the title rode the top edge alone. */}
                  <div className="drawer-header">
                    <DialogTitle className="drawer-title">Channels</DialogTitle>
                    <DialogClose aria-label="Close navigation" className="drawer-close">
                      ✕
                    </DialogClose>
                  </div>
                  {/* Workspace strip (KTD2): the same workspaceRail content the
                      desktop rail hosts — Home + Integrations + workspaces —
                      laid out horizontally above the channel list. Selecting
                      anything here closes the drawer (the drawerFooter idiom). */}
                  <div
                    className="drawer-workspace-strip"
                    data-testid="drawer-workspace-strip"
                    onClick={() => setNavOpen(false)}
                  >
                    {workspaceRail}
                  </div>
                  {sidebar}
                  {userPanel ? (
                    <div className="drawer-user-panel" data-testid="drawer-user-panel">
                      {userPanel}
                    </div>
                  ) : null}
                  {drawerFooter ? (
                    <div
                      className="mt-auto border-t border-line px-3 py-2"
                      data-testid="drawer-footer"
                      onClick={() => setNavOpen(false)}
                    >
                      {drawerFooter}
                    </div>
                  ) : null}
              </DialogContent>
            </Dialog>
          }
          railTrigger={
            railHidden ? undefined : (
              <Dialog
                open={drawerMode !== null}
                onOpenChange={(open) => {
                  // One source of truth: closing the drawer clears the mode, and
                  // pressing the open icon again is what clears it. No separate
                  // `membersOpen` flag to drift out of step with the mode.
                  if (!open && drawerMode !== null) onRailSelect(drawerMode);
                }}
              >
                {/* NOT a DialogTrigger: Radix renders that as a <button>, and
                    nesting three icon buttons inside one is invalid HTML with
                    broken click semantics. The icons drive the controlled
                    `open` directly instead. */}
                <RailIcons mode={drawerMode} onSelect={selectDrawerMode} modes={railModes} />
                <DialogContent
                    showCloseButton={false}
                    overlayClassName="drawer-overlay"
                    aria-label={drawerMode !== null ? RAIL_TITLES[drawerMode] : 'Side panels'}
                    className="drawer members"
                  >
                    <div className="drawer-header">
                      <DialogTitle className="drawer-title">
                        {drawerMode !== null ? RAIL_TITLES[drawerMode] : ''}
                      </DialogTitle>
                      {/* The icons ride the PANEL header too, exactly as RailPane
                          does at tablet — and this is what makes the owner's
                          toggle model work at phone. A modal drawer makes
                          everything OUTSIDE it inert, so the topbar's icons are
                          unreachable while the panel is open; a control inside
                          the content is not. Same icon closes, another
                          replaces, and the ratified scrim is untouched. */}
                      <RailIcons mode={drawerMode} onSelect={selectDrawerMode} modes={railModes} />
                      <DialogClose aria-label="Close side panel" className="drawer-close">
                        ✕
                      </DialogClose>
                    </div>
                    {railContent}
                  </DialogContent>
              </Dialog>
            )
          }
        />
      ) : (
        /* Desktop left cluster: rail | sidebar on row 1, each column's own
           footer on row 2 — the user panel under the SIDEBAR's column and
           the build badge under the RAIL's. */
        <div className="left-cluster" data-testid="left-cluster">
          <nav aria-label="Workspaces" data-testid="workspace-rail" className="rail">
            {workspaceRail}
          </nav>
          <nav aria-label="Channels" data-testid="channel-sidebar" className="sidebar">
            {sidebar}
          </nav>
          {userPanel ? (
            <div className="user-panel-region" data-testid="user-panel-region">
              {userPanel}
            </div>
          ) : null}
          {railFooter ? (
            <div className="rail-footer" data-testid="rail-footer">
              {railFooter}
            </div>
          ) : null}
        </div>
      )}

      {!isMobile ? (
        <>
          {/* Boundary drag handles: sidebar | pane and pane | members.
              role=separator + Arrow keys carry the keyboard contract; the
              members handle hides below 1280px where its track collapses, and
              it is gone entirely when the rail itself is hidden — a handle for
              a boundary that does not exist is an invisible drag target, and
              it also left a live tab stop on Home (measured 2026-09-14). */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize channels sidebar"
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            tabIndex={0}
            className="shell-resize-handle shell-resize-handle-sidebar"
            data-testid="resize-sidebar"
            onPointerDown={(e) =>
              startColumnDrag(
                e,
                sidebarWidth,
                1,
                clampSidebar,
                setSidebarWidth,
                (w) => writeWidth('cytale.shell.sidebar', w),
              )
            }
            onKeyDown={(e) => onSepKeyDown(e, nudgeSidebar)}
          />
          {railHidden ? null : (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize members rail"
              aria-valuenow={membersWidth}
              aria-valuemin={MEMBERS_MIN}
              aria-valuemax={MEMBERS_MAX}
              tabIndex={0}
              className="shell-resize-handle shell-resize-handle-members"
              data-testid="resize-members"
              onPointerDown={(e) =>
                startColumnDrag(
                  e,
                  membersWidth,
                  -1,
                  clampMembers,
                  setMembersWidth,
                  (w) => writeWidth('cytale.shell.members', w),
                )
              }
              onKeyDown={(e) => onSepKeyDown(e, nudgeMembers)}
            />
          )}
        </>
      ) : null}

      <main
        aria-label={permissionDenied ? 'Messages (access denied)' : 'Messages'}
        data-testid="message-pane"
        data-permission-denied={permissionDenied ? 'true' : undefined}
        className="pane"
      >
        {permissionDenied ? (
          <div role="alert" data-testid="permission-denied">
            {permissionDenied}
          </div>
        ) : isTablet && railOpen && !railHidden ? (
          /* Tablet: the selected mode holds the pane (no fourth track to dock
             into). The icons render inside this header too — same control, same
             corner, so opening and closing never move the affordance. */
          <RailPane mode={railMode!} onSelectMode={onRailSelect} modes={railModes}>
            {railContent}
          </RailPane>
        ) : (
          messagePane
        )}
        {viewOnly && !permissionDenied ? (
          <p data-testid="view-only-note">View-only — you cannot send messages here.</p>
        ) : null}
      </main>

      {/* Members region — the static rail is a DESKTOP COLUMN, because the
          fourth grid track only exists at ≥1280px (shell.css). Rendering the
          aside at tablet widths is what produced the #86 defect: with no track
          for it, auto-placement dropped it into the shell's SECOND row, where
          it became a ~72px-wide member strip and the left cluster + pane lost
          the height it took (44% of an 834×1210 screen abandoned).

          So this aside renders only at desktop, and only when the host says the
          surface carries members. Every other band reaches the list another
          way: phone through the topbar's 👥 drawer, tablet by the pane swap
          below (which replaces `messagePane` rather than docking beside it).
          Home opts out entirely via `railHidden` (owner direction
          2026-09-12: the dashboard carries no member list at any width), which
          is why the old inline-mobile-aside clause is gone — nothing can reach
          it now, and a dead branch that still compiles is a trap for the next
          reader. */}
      {isDesktop && railOpen && !railHidden ? (
        <aside
          aria-label={railMode === 'members' ? 'Members' : railMode === 'calls' ? 'Call log' : 'Threads'}
          data-testid="member-list"
          className="members-rail"
        >
          {/* The SAME pane the tablet band swaps in, header and all — so the
              three mode icons ride inside the open column at desktop too
              (owner direction 2026-09-13). The column therefore arrives over
              the corner those icons occupied, and the control the user just
              pressed is in the header of what it opened. ONE component for both
              bands is the point: two headers would be two places to drift. */}
          <RailPane mode={railMode!} onSelectMode={onRailSelect} modes={railModes}>
            {railContent}
          </RailPane>
        </aside>
      ) : null}

      {/* Bot modals (#30): portalled by Radix, so placement here is only
          lifetime — the host lives exactly as long as the signed-in shell. */}
      <InteractionModalHost />
    </div>
  );
}
