/**
 * @cytale/web — message action rows (components plan U4, R7/R8 render half).
 *
 * Renders a machine-authored message's `components` (buttons and string
 * selects, the Discord action-row model) at the bottom of the message body —
 * below the embeds and attachments, directly above the reaction row. The
 * owner's report of 2026-09-18 ("move the option buttons to the underside of
 * the box asking the question") is what settled it; U4's R7 text had claimed
 * action rows sit above the embeds and called that "Discord's order", while
 * U4's Files line named this slot. See the render-site note in
 * MessageItem.tsx. The reaction-chip idiom scaled up:
 *
 *  - Styles 1-4 are real `<button type="button">` elements with a
 *    token-disciplined style mapping (accent / secondary / success / danger
 *    — never raw Discord colors, KTD7); style 5 renders as an http/https-only
 *    anchor (the scheme is re-checked before any href is emitted; a
 *    `javascript:`/`data:`/protocol-relative url renders INERT) and never
 *    enters the ingress.
 *  - The string select follows the ReactionPicker keyboard contract exactly:
 *    arrows move, Enter/Space picks, Escape closes and returns focus to the
 *    trigger, Tab and outside-pointer dismiss. Single-select v1.
 *  - Controls disable when: the component JSON carries `disabled: true` (the
 *    resolved-card state), a click on THAT control is pending (the store-
 *    scoped double-click guard), the connection is offline, the owning bot
 *    is gone from the roster projection (revoked/deleted — the author's
 *    machine kind no longer resolves), or the viewer is read-only (no send
 *    right — pre-disabled with an explanatory title, never enabled buttons
 *    that 403). Human-authored rows carrying a components key (defensive —
 *    impossible post-validation) render nothing.
 *  - Clicks run through useComponentClick: pending is store-scoped by
 *    (message_id, custom_id) so react-virtuoso remounts keep the control
 *    pending; completion is the bot's answer (KTD6); failures render an
 *    inline role=alert — 403 permission-denied copy, the dead-button copy
 *    and the "didn't confirm" notice (the bot posted but never answered the
 *    click) are Dismiss-only, everything else retries.
 *  - WCAG 2.1 AA: every control and option has a ≥40×40px hit area
 *    (UX_SPEC §6), focus rings on all controls, and a polite live region on
 *    the block announces card flips and the clicker's pending→resolved
 *    transition (silent DOM changes fail the standing pin).
 */

import { useEffect, useRef, useState } from 'react';

import type { PrincipalKind } from '@cytale/domain';
import type { StateStore } from '@cytale/state';
import { defaultStore } from '@cytale/state';

import { useOnlineStatus } from '../../app/pwa/useOnlineStatus.js';
import { useComponentClick, type ComponentClickStatus } from '../commands/useComponentClick.js';
import type {
  MessageWithBots,
  ParsedButtonControl,
  ParsedControl,
  ParsedSelectControl,
  ParsedSelectOption,
} from './types.js';

// ---------------------------------------------------------------------------
// Untrusted-JSON parsing (the EmbedCard idiom: shallow checks, malformed
// pieces drop out degraded, one bad row never unmounts the tree)
// ---------------------------------------------------------------------------

/** Parse the wire's action rows into render contracts; anything unshapeable
 * drops out (unknown row/component types are silently skipped). */
export function parseActionRows(components: unknown): ParsedControl[][] {
  if (!Array.isArray(components)) return [];
  const rows: ParsedControl[][] = [];
  for (const row of components) {
    if (row === null || typeof row !== 'object') continue;
    const rowObj = row as Record<string, unknown>;
    if (rowObj.type !== 1) continue; // only action rows render v1
    const inner = rowObj.components;
    if (!Array.isArray(inner)) continue;
    const controls: ParsedControl[] = [];
    for (const c of inner) {
      const parsed = parseControl(c);
      if (parsed !== null) controls.push(parsed);
    }
    if (controls.length > 0) rows.push(controls);
  }
  return rows;
}

function parseControl(c: unknown): ParsedControl | null {
  if (c === null || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const disabled = o.disabled === true;

  if (o.type === 2) {
    const style =
      typeof o.style === 'number' && Number.isInteger(o.style) && o.style >= 1 && o.style <= 5
        ? o.style
        : 2; // unknown styles degrade to secondary
    const label = typeof o.label === 'string' ? o.label : '';
    const customId = typeof o.custom_id === 'string' && o.custom_id.length > 0 ? o.custom_id : null;
    const button: ParsedButtonControl = {
      kind: 'button',
      customId,
      label,
      style,
      disabled,
    };
    if (style === 5) button.url = o.url;
    return button;
  }

  if (o.type === 3) {
    const customId = typeof o.custom_id === 'string' && o.custom_id.length > 0 ? o.custom_id : null;
    const placeholder =
      typeof o.placeholder === 'string' && o.placeholder !== ''
        ? o.placeholder
        : 'Make a selection';
    const options: ParsedSelectOption[] = [];
    if (Array.isArray(o.options)) {
      for (const opt of o.options) {
        if (opt === null || typeof opt !== 'object') continue;
        const oo = opt as Record<string, unknown>;
        if (typeof oo.label !== 'string' || typeof oo.value !== 'string') continue;
        options.push({
          label: oo.label,
          value: oo.value,
          ...(typeof oo.description === 'string' ? { description: oo.description } : {}),
        });
      }
    }
    // A select without identity or without any renderable option is dead
    // air — nothing to open, nothing to submit.
    if (customId === null || options.length === 0) return null;
    // Discord's range (#30): each side defaults to 1; clamp to what the
    // options can satisfy so a malformed row degrades instead of locking.
    const int = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isInteger(v) ? v : fallback;
    const maxValues = Math.min(Math.max(int(o.max_values, 1), 1), options.length);
    const minValues = Math.min(Math.max(int(o.min_values, 1), 0), maxValues);
    const select: ParsedSelectControl = {
      kind: 'select',
      customId,
      placeholder,
      options,
      disabled,
      minValues,
      maxValues,
    };
    return select;
  }

  return null;
}

/**
 * KTD7 render-side scheme guard: http/https absolute only. `javascript:`,
 * `data:`, protocol-relative and anything unparsable yield null — the anchor
 * renders inert (no href, never navigates).
 */
export function safeLinkHref(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  if (!/^https?:\/\//i.test(url)) return null; // rejects protocol-relative too
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Copy (§9 states-first + the R7 permission-denied / dead-button pins)
// ---------------------------------------------------------------------------

export const COMPONENT_OFFLINE_TITLE =
  'You are offline — component interactions are unavailable until reconnection';
export const COMPONENT_VIEW_ONLY_TITLE =
  'Read-only access — you need permission to send messages in this channel to use components';
export const COMPONENT_DEAD_TITLE =
  'This component is unavailable — its bot is no longer active';
const PENDING_TITLE = 'Waiting for the bot to respond';
const RESOLVED_TITLE = 'This control is no longer active';

const NO_RESPONSE_COPY =
  'No response yet — the bot may still be processing. If it arrives, it will appear here.';
const UNACKNOWLEDGED_COPY =
  "The bot didn't confirm this click, but it has posted since — check whether it acted before trying again.";
const PERMISSION_DENIED_COPY = "You can't interact with components in this channel.";
const DEAD_COPY = 'This component is no longer available.';

// ---------------------------------------------------------------------------
// Style mapping (token-disciplined; the four custom styles + the link anchor)
// ---------------------------------------------------------------------------

const BTN_BASE =
  'flex h-10 min-w-10 items-center justify-center rounded-md px-4 text-sm font-medium ' +
  'transition-colors duration-[var(--duration-control)] focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

const BTN_STYLE: Record<number, string> = {
  1: 'bg-accent text-text-onaccent hover:bg-accent-hover',
  2: 'border border-border-strong bg-surface text-text hover:bg-surface-hover',
  3: 'bg-success text-text-onaccent hover:opacity-90',
  4: 'bg-danger text-text-onaccent hover:opacity-90',
};

// ---------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------

export interface MessageComponentsProps {
  message: MessageWithBots;
  /** The author's roster principal kind — liveness rides the roster (R8):
   * a machine kind means the bot is live; a missing row means dead. */
  authorKind?: PrincipalKind | null;
  /** Read-only viewer (no send right): controls pre-disabled with a title. */
  viewOnly?: boolean;
  /** U17 store (injectable for tests; defaults to the module store). */
  store?: StateStore;
}

export function MessageComponents({
  message,
  authorKind,
  viewOnly = false,
  store,
}: MessageComponentsProps) {
  const click = useComponentClick(store);

  // Defensive suppressions: the optimistic-send placeholder never carries
  // components (native create ignores them), and a human-authored row with
  // a components key (impossible post-validation) renders nothing (R1).
  const isPlaceholderRow =
    typeof message.id === 'string' && message.id.startsWith('pending_');
  const humanAuthored = authorKind === 'human';
  const rows = parseActionRows(message.components);
  const renderable = rows.length > 0 && !isPlaceholderRow && !humanAuthored;

  // Liveness from the roster projection: an unresolvable author (the
  // synthesized machine entry vanished — revoked/deleted bot) disables the
  // controls; the R1 invariant means a components row is machine-authored
  // by construction, so "unknown" here reads as dead, never as human.
  const botDead = authorKind == null;

  // Polite announcements (R7): card flips + the clicker's click ANSWERED.
  // ONE effect with resolution-priority — the store-driven resolution and
  // the props-driven flip land in quick succession on the same answer, and
  // "Your request completed" is the message that must survive. Completion
  // is the click machine's answered count, never "no longer pending": the
  // ~10s no-response fallback also ends pending, and announcing completion
  // there (beside the "No response yet" alert) was the 2026-10-01 report.
  const [announcement, setAnnouncement] = useState('');
  const customIds = renderable
    ? rows.flatMap((controls) =>
        controls.flatMap((c) => (c.customId !== null ? [c.customId] : [])),
      )
    : [];
  const answered = customIds.reduce(
    (sum, id) => sum + click.resolutionCount(message.id, id),
    0,
  );
  const announceRef = useRef<{
    answered: number;
    editedAt: string | null;
    components: unknown;
  } | null>(null);
  /** The row signature the click's OWN resolution produces — its props
   * catch-up flip is already covered by "Your request completed" and must
   * not overwrite it (the store row is authoritative at resolution time). */
  const absorbedSigRef = useRef<string | null>(null);
  const watchStore = store ?? defaultStore;
  useEffect(() => {
    const current = {
      answered,
      editedAt: message.edited_at ?? null,
      components: message.components ?? null,
    };
    const prev = announceRef.current;
    announceRef.current = current;
    if (prev === null || !renderable) return;
    const resolved = current.answered > prev.answered;
    if (resolved) {
      setAnnouncement('Your request completed');
      // The row lives in the THREAD slice for a card inside a thread.
      const state = watchStore.getState();
      const slice = message.thread_id
        ? state.messagesByThread[message.thread_id]
        : state.messagesByChannel[message.channel_id];
      const row = slice?.items.find((m) => m.id === message.id);
      absorbedSigRef.current = `${row?.edited_at ?? ''}|${JSON.stringify(row?.components ?? null)}`;
      return;
    }
    const flipped =
      prev.editedAt !== current.editedAt || prev.components !== current.components;
    if (!flipped) return;
    const sig = `${current.editedAt ?? ''}|${JSON.stringify(current.components)}`;
    if (sig === absorbedSigRef.current) {
      absorbedSigRef.current = null; // the resolution's own flip catching up
      return;
    }
    setAnnouncement('Card updated');
  }, [answered, message.edited_at, message.components, renderable, watchStore, message.channel_id, message.thread_id, message.id]);

  if (!renderable) return null;

  const submit = (control: ParsedControl, values?: string[]): void => {
    if (control.customId === null) return;
    void click.click({
      messageId: message.id,
      channelId: message.channel_id,
      ...(message.thread_id ? { threadId: message.thread_id } : {}),
      applicationId: message.author_id,
      customId: control.customId,
      componentType: control.kind === 'button' ? 2 : 3,
      ...(values !== undefined ? { values } : {}),
    });
  };

  return (
    <div
      className="mt-1 flex flex-col gap-1"
      data-testid="component-block"
      data-message-id={message.id}
    >
      <div
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="component-live-region"
      >
        {announcement}
      </div>
      {rows.map((controls, rowIndex) => (
        <div
          key={rowIndex}
          className="flex flex-wrap items-center gap-1.5"
          data-testid="component-row"
          role="group"
          aria-label="Message actions"
        >
          {controls.map((control, controlIndex) => (
            <ControlView
              // Position-stable (NOT customId): a MessageUpdate that
              // replaces the row must not remount an open select popover —
              // the stale-submit scenario keeps the menu mounted while its
              // options re-render.
              key={`${control.kind}-${controlIndex}`}
              control={control}
              status={
                control.customId !== null
                  ? click.statusFor(message.id, control.customId)
                  : ({ kind: 'idle' } as ComponentClickStatus)
              }
              botDead={botDead}
              viewOnly={viewOnly}
              onSubmit={submit}
              onRetry={click.retry}
              onDismiss={click.dismiss}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One control (button / link anchor / select) + its inline error affordance
// ---------------------------------------------------------------------------

interface ControlViewProps {
  control: ParsedControl;
  status: ComponentClickStatus;
  botDead: boolean;
  viewOnly: boolean;
  onSubmit: (control: ParsedControl, values?: string[]) => void;
  onRetry: (messageId: string, customId: string) => Promise<void>;
  onDismiss: (messageId: string, customId: string) => void;
}

function ControlView({
  control,
  status,
  botDead,
  viewOnly,
  onSubmit,
  onRetry,
  onDismiss,
}: ControlViewProps) {
  const online = useOnlineStatus();
  const pending = status.kind === 'pending';
  // A style-5 link never enters the ingress — it needs no custom_id; every
  // interactive control does (a missing one renders inert, defensive-only).
  const identityMissing =
    control.customId === null && !(control.kind === 'button' && control.style === 5);
  const disabled =
    control.disabled || pending || !online || botDead || viewOnly || identityMissing;
  const title = disabled
    ? !online
      ? COMPONENT_OFFLINE_TITLE
      : viewOnly
        ? COMPONENT_VIEW_ONLY_TITLE
        : botDead
          ? COMPONENT_DEAD_TITLE
          : pending
            ? PENDING_TITLE
            : RESOLVED_TITLE
    : undefined;

  return (
    <>
      {control.kind === 'button' && control.style === 5 ? (
        <LinkButton control={control} disabled={disabled} title={title ?? undefined} />
      ) : control.kind === 'button' ? (
        <button
          type="button"
          className={`${BTN_BASE} ${BTN_STYLE[control.style] ?? BTN_STYLE[2]!}`}
          data-testid="component-button"
          data-custom-id={control.customId ?? undefined}
          data-style={control.style}
          data-pending={pending || undefined}
          disabled={disabled}
          title={title ?? undefined}
          onClick={() => onSubmit(control)}
        >
          {control.label !== '' ? control.label : 'Button'}
        </button>
      ) : (
        <SelectControl
          control={control}
          disabled={disabled}
          pending={pending}
          title={title ?? undefined}
          onSubmit={onSubmit}
        />
      )}

      {status.kind === 'no-response' || status.kind === 'unacknowledged' || status.kind === 'error' ? (
        <ComponentError
          status={status}
          onRetry={onRetry}
          onDismiss={onDismiss}
        />
      ) : null}
    </>
  );
}

/** The style-5 link button: an http/https-only anchor, never a POST. */
function LinkButton({
  control,
  disabled,
  title,
}: {
  control: ParsedButtonControl;
  disabled: boolean;
  title?: string;
}) {
  const href = disabled ? null : safeLinkHref(control.url);
  const base =
    'flex h-10 min-w-10 items-center justify-center rounded-md border border-border-strong ' +
    'bg-surface px-4 text-sm font-medium text-accent underline-offset-2 ' +
    'transition-colors duration-[var(--duration-control)] focus-visible:outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';
  if (href === null) {
    // Inert render: no href (not focusable, never navigates) — the scheme
    // guard rejected the url or the control is disabled.
    return (
      <a
        className={`${base} cursor-not-allowed opacity-50 no-underline`}
        aria-disabled="true"
        data-testid="component-link"
        data-custom-id={control.customId ?? undefined}
        data-style={5}
        data-inert=""
        title={title ?? (safeLinkHref(control.url) === null ? 'Link unavailable' : undefined)}
      >
        {control.label !== '' ? control.label : 'Link'}
      </a>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={`${base} hover:bg-surface-hover hover:underline`}
      data-testid="component-link"
      data-custom-id={control.customId ?? undefined}
      data-style={5}
      title={title}
    >
      {control.label !== '' ? control.label : 'Link'}
    </a>
  );
}

// ---------------------------------------------------------------------------
// String select (the ReactionPicker keyboard contract: arrows / enter /
// escape, focus return, Tab + outside-pointer dismissal)
// ---------------------------------------------------------------------------

const TRIGGER_CLASS =
  'flex h-10 min-w-10 items-center justify-between gap-2 rounded-md border border-border-strong ' +
  'bg-surface px-3 text-sm text-text transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

const OPTION_CLASS =
  'flex min-h-10 w-full items-center justify-between gap-3 rounded-md px-3 py-1.5 text-left ' +
  'text-sm text-text transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover focus-visible:outline-none focus-visible:bg-surface-hover ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

function SelectControl({
  control,
  disabled,
  pending,
  title,
  onSubmit,
}: {
  control: ParsedSelectControl;
  disabled: boolean;
  pending: boolean;
  title?: string;
  onSubmit: (control: ParsedControl, values?: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [pickedValue, setPickedValue] = useState<string | null>(null);
  // Multi-pick (#30): `submitted` is the last set sent; `draft` is the set
  // being edited while the menu is open (Escape throws the draft away).
  const multi = control.maxValues > 1;
  const [submitted, setSubmitted] = useState<string[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Outside pointer press closes (the picker contract).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const choose = (value: string): void => {
    setPickedValue(value);
    close();
    onSubmit(control, [value]);
  };

  // Multi: toggle one option in the draft; a pick past max_values is refused
  // (the checkbox simply does not tick) rather than silently dropping another.
  const toggle = (value: string): void => {
    setDraft((d) => {
      if (d.includes(value)) return d.filter((v) => v !== value);
      if (d.length >= control.maxValues) return d;
      return [...d, value];
    });
  };
  const draftValid = draft.length >= control.minValues && draft.length <= control.maxValues;
  const confirm = (): void => {
    if (!draftValid) return;
    // Values ride in OPTION order, not click order — stable for the bot.
    const ordered = control.options.map((o) => o.value).filter((v) => draft.includes(v));
    setSubmitted(ordered);
    close();
    onSubmit(control, ordered);
  };

  // The focus ring cycles the options, plus the Submit row in multi mode.
  const ringSize = control.options.length + (multi ? 1 : 0);
  const step = (delta: number): void => {
    const n = ringSize;
    setFocusIndex((i) => (i + delta + n * Math.ceil(Math.abs(delta) / n)) % n);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        step(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        step(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!multi) {
          choose(control.options[focusIndex]?.value ?? control.options[0]!.value);
        } else if (focusIndex === control.options.length) {
          confirm();
        } else {
          toggle(control.options[focusIndex]!.value);
        }
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        // Focus escaping the menu dismisses it (focus-safe popover).
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const picked =
    pickedValue !== null ? control.options.find((o) => o.value === pickedValue) : undefined;
  const submittedLabels = control.options
    .filter((o) => submitted.includes(o.value))
    .map((o) => o.label);
  const triggerText = multi
    ? submittedLabels.length === 0
      ? control.placeholder
      : submittedLabels.length === 1
        ? submittedLabels[0]!
        : `${submittedLabels.length} selected`
    : picked
      ? picked.label
      : control.placeholder;
  const triggerAria = multi
    ? `Options menu, choose ${
        control.minValues === control.maxValues
          ? control.maxValues
          : `${control.minValues} to ${control.maxValues}`
      }${submittedLabels.length > 0 ? `, ${submittedLabels.join(', ')} selected` : ''}`
    : `Options menu${picked ? `, ${picked.label} selected` : ''}`;

  return (
    <div
      className="relative inline-flex"
      ref={rootRef}
      onKeyDown={open ? onKeyDown : undefined}
      data-testid="component-select-root"
    >
      <button
        type="button"
        ref={triggerRef}
        className={TRIGGER_CLASS}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerAria}
        data-testid="component-select"
        data-custom-id={control.customId ?? undefined}
        data-pending={pending || undefined}
        disabled={disabled}
        title={title}
        onClick={() => {
          if (disabled) return;
          setFocusIndex(0);
          setDraft(submitted);
          setOpen((o) => !o);
        }}
      >
        <span className="truncate">{triggerText}</span>
        <span aria-hidden className="text-text-muted">
          ▾
        </span>
      </button>

      {open ? (
        <div
          className="absolute top-full left-0 z-20 mt-1 flex max-h-64 w-64 flex-col gap-0.5 overflow-y-auto popover p-1.5"
          role="menu"
          aria-label={control.placeholder}
          data-testid="component-select-menu"
        >
          {control.options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              role={multi ? 'menuitemcheckbox' : 'menuitem'}
              {...(multi ? { 'aria-checked': draft.includes(opt.value) } : {})}
              className={OPTION_CLASS}
              aria-label={opt.description ? `${opt.label} — ${opt.description}` : opt.label}
              data-testid="component-option"
              data-value={opt.value}
              tabIndex={-1}
              ref={i === focusIndex ? (el) => el?.focus() : undefined}
              onClick={() => (multi ? toggle(opt.value) : choose(opt.value))}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-text">{opt.label}</span>
                {opt.description ? (
                  <span className="block truncate text-xs text-text-muted">{opt.description}</span>
                ) : null}
              </span>
              {(multi ? draft.includes(opt.value) : pickedValue === opt.value) ? (
                <span aria-hidden className="text-accent">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
          {multi ? (
            <button
              type="button"
              role="menuitem"
              className={`${OPTION_CLASS} justify-center border-t border-line font-medium`}
              data-testid="component-select-submit"
              aria-disabled={!draftValid}
              tabIndex={-1}
              ref={focusIndex === control.options.length ? (el) => el?.focus() : undefined}
              onClick={confirm}
            >
              {draftValid
                ? `Submit (${draft.length})`
                : `Choose ${control.minValues === control.maxValues ? control.maxValues : `${control.minValues}–${control.maxValues}`}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline error affordance (role=alert; Retry/Dismiss; 403 + dead are
// Dismiss-only — permanent denials never offer retry)
// ---------------------------------------------------------------------------

function ComponentError({
  status,
  onRetry,
  onDismiss,
}: {
  status: ComponentClickStatus;
  onRetry: (messageId: string, customId: string) => Promise<void>;
  onDismiss: (messageId: string, customId: string) => void;
}) {
  if (status.kind !== 'no-response' && status.kind !== 'unacknowledged' && status.kind !== 'error')
    return null;
  const copy =
    status.kind === 'no-response'
      ? NO_RESPONSE_COPY
      : status.kind === 'unacknowledged'
        ? UNACKNOWLEDGED_COPY
        : status.forbidden
        ? PERMISSION_DENIED_COPY
        : status.dead
          ? DEAD_COPY
          : status.error;
  const retryable = status.kind === 'no-response' || (status.kind === 'error' && !status.forbidden && !status.dead);
  const actionBtn =
    'rounded px-1.5 text-xs transition-colors duration-[var(--duration-control)] ' +
    'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-[var(--color-focus)]';

  return (
    <span
      role="alert"
      className="inline-flex flex-wrap items-center gap-1.5 text-xs text-danger"
      data-testid="component-error"
    >
      <span data-testid="component-error-message">{copy}</span>
      {retryable ? (
        <button
          type="button"
          className={`${actionBtn} font-medium text-accent`}
          data-testid="component-retry"
          onClick={() => void onRetry(status.messageId, status.customId)}
        >
          Retry
        </button>
      ) : null}
      <button
        type="button"
        className={`${actionBtn} text-text-muted`}
        data-testid="component-dismiss"
        onClick={() => onDismiss(status.messageId, status.customId)}
      >
        Dismiss
      </button>
    </span>
  );
}
