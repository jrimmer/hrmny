/**
 * @cytale/web — MobileTopbar (U1, mobile shell chrome v2).
 *
 * The shell's ONLY mobile chrome (KTD1): a fixed-height 48px band carrying
 * the navigation trigger (the active workspace's icon since 2026-09-18 —
 * was the ☰ glyph; falls back to ☰ when no workspace is active), a
 * left-aligned title slot beside it, the join-voice control, and the 👥
 * members trigger (U2 added title + join-voice — audit B3: voice was
 * unreachable at mobile, zero call controls in the DOM).
 *
 * The triggers arrive as slots so they stay INSIDE their owning
 * Dialog.Root compositions in AppShell (drawer semantics + focus trap are
 * untouched by this component) — what changed vs. the old shell is WHERE
 * the trigger buttons render: as constrained inline-flex 44×44 controls
 * inside this bar, never as direct grid/flex children of `.shell` (the B1
 * defect: grid-stretched invisible full-width tap blocks). Sizing lives in
 * shell.css (.mobile-topbar / .mobile-topbar-action).
 *
 * TopbarCallAction is the join-voice control: chrome that mirrors the
 * desktop pane header's ChannelHeaderCallActions states 1:1 (join live vs
 * start vs permission-hidden) and fires the same useChannelCallHeader
 * intents — starting/joining opens the existing CallPanel mobile sheet
 * through the engine, exactly like the desktop header button.
 */
import type { ReactNode } from 'react';

import { headerIconButtonClass } from '../ui/button.js';
import { PhoneIcon } from '../ui/icons.js';

export interface MobileTopbarProps {
  /** Left control — the channels-drawer Dialog composition (trigger + portal). */
  navTrigger?: ReactNode;
  /**
   * Center title slot — workspace/channel name (U2 fills it via AppShell's mobileTitle).
   * Left-aligned beside the nav trigger (2026-09-18): it labels the workspace
   * icon that replaced the ☰, so centering would drive them apart.
   */
  title?: ReactNode;
  /**
   * Muted sigil before the title (`#` channel / `@` DM) — aria-hidden, the
   * desktop pane-header idiom. Null/omitted renders nothing (Home).
   */
  titleSigil?: string | null;
  /** Join-voice control (U2) — a TopbarCallAction, rendered beside the members trigger. */
  callAction?: ReactNode;
  /**
   * Right slot — the side-panel Dialog composition (trigger + portal) carrying
   * the members/calls/threads icons. Renamed from `membersTrigger` when the
   * owner's 2026-09-12 direction gave the phone band all three modes: the slot
   * never was members-specific, the name just predated the second mode.
   *
   * The icons are narrower than the 44px topbar actions (40px) so three of them
   * plus ☰, the title and the call control still fit a 390px bar.
   */
  railTrigger?: ReactNode;
}

export function MobileTopbar({ navTrigger, title, titleSigil, callAction, railTrigger }: MobileTopbarProps) {
  return (
    <header className="mobile-topbar" data-testid="mobile-topbar">
      {navTrigger}
      <span className="mobile-topbar-title">
        {titleSigil ? (
          <span aria-hidden className="mobile-topbar-sigil">
            {titleSigil}
          </span>
        ) : null}
        {title}
      </span>
      {callAction}
      {railTrigger}
    </header>
  );
}

// ---------------------------------------------------------------------------
// U2 — the join-voice control
// ---------------------------------------------------------------------------

export interface TopbarCallActionProps {
  /** True while a call is live in this channel (button reads "Join"). */
  live: boolean;
  /** True while the channel's call is ringing this client (U11 emphasis). */
  ringing?: boolean;
  /** START_CALL-gated (hidden when denied and idle, AM17 — desktop parity). */
  canStartCall: boolean;
  onStart(opts: { ring: boolean }): void;
  onJoin(): void;
}

/**
 * The topbar's join-voice control: the desktop pane header's call affordance
 * as the shared header icon control — the same 40px bare icon as the
 * side-column icons beside it (one of which is the call LOG's phone glyph,
 * so two styles side by side read as two different kinds of thing). Accessible names match the
 * desktop buttons exactly ('Start call' / 'Join call' / 'Join call —
 * ringing') so keyboard + screen-reader users meet one consistent contract
 * across breakpoints; the intents fire the shared useChannelCallHeader seam,
 * which opens the existing CallPanel mobile sheet.
 */
export function TopbarCallAction({
  live,
  ringing = false,
  canStartCall,
  onStart,
  onJoin,
}: TopbarCallActionProps) {
  if (!live && !canStartCall) return null; // permission-hidden (AM17)

  if (live) {
    return (
      <button
        type="button"
        className={headerIconButtonClass + (ringing ? ' ring-emph' : '')}
        aria-label={ringing ? 'Join call — ringing' : 'Join call'}
        title={ringing ? 'Join call — ringing' : 'Join call'}
        data-testid="topbar-join-call"
        data-ringing={ringing || undefined}
        onClick={onJoin}
      >
        <PhoneIcon size={18} />
      </button>
    );
  }

  return (
    <button
      type="button"
      className={headerIconButtonClass}
      aria-label="Start call"
      title="Start call"
      data-testid="topbar-start-call"
      onClick={() => onStart({ ring: false })}
    >
      <PhoneIcon size={18} />
    </button>
  );
}
