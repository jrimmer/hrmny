/**
 * @cytale/web — the header notification control (notification controls,
 * 2026-09-27).
 *
 * ONE icon button that says how loudly this channel (or DM, or thread) can
 * reach the member, and changes it in one click:
 *
 *   click          cycles bell (All messages) → @ (Mentions only) →
 *                  bell-off (Nothing) → bell, writing an EXPLICIT row at the
 *                  target's own layer
 *   right-click /  opens the full menu: the three levels plus "Use workspace
 *   long-press     default" (Radix DropdownMenu on desktop; the `sheet`
 *   / Shift+F10    variant opens a bottom sheet instead — the phone topbar)
 *
 * The icon shows the EFFECTIVE level. While the target has no row of its own
 * it is INHERITING, and the button renders quieter (the muted header tone
 * instead of the primary one) with the provenance in its name: "Notifications:
 * Mentions only (workspace default) — click for Nothing". The name always
 * states the current AND the next state, so the one button is operable
 * without sight of the icon.
 *
 * After a click a short confirmation appears under the control ("Notifications:
 * Nothing") through a polite live region — non-blocking, gone after a beat.
 * The write is optimistic in the shared store (every surface moves at once);
 * a refusal rolls the store back and the control says so in an alert.
 */

import { useEffect, useRef, useState } from 'react';

import { defaultStore, type StateStore } from '@cytale/state';

import { useChannelLongPress } from '../channels/ChannelContextMenu.js';
import { Dialog, DialogContent, DialogTitle } from '../../components/shadcn/dialog.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../components/shadcn/dropdown-menu.js';
import { LevelIcon, NotificationLevelMenuGroup } from './NotificationLevelMenu.js';
import {
  clearTargetLevel,
  controlLabel,
  LEVEL_LABEL,
  nextNotificationLevel,
  resetLabel,
  setTargetLevel,
  useNotificationTarget,
  WRITE_FAILED_MESSAGE,
  type NotificationLevel,
  type NotificationTarget,
} from './notificationPrefs.js';

/** How long the "Notifications: …" confirmation stays up. */
export const CONFIRM_MS = 2200;

export interface NotificationLevelControlProps {
  target: NotificationTarget;
  /** `menu` (desktop header: right-click menu) or `sheet` (phone topbar). */
  variant?: 'menu' | 'sheet';
  /** The button's class — the host's header-action idiom. */
  className?: string;
  /** Glyph size (the phone topbar draws 18). */
  iconSize?: number;
  /** Names the target in the sheet's title ("#general"). */
  targetName?: string;
  testIdPrefix?: string;
  store?: StateStore;
}

export function NotificationLevelControl({
  target,
  variant = 'menu',
  className = '',
  iconSize = 16,
  targetName,
  testIdPrefix = 'notif-control',
  store = defaultStore,
}: NotificationLevelControlProps) {
  const view = useNotificationTarget(target, store);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // A different target (channel switch) starts clean: a confirmation or an
  // error about the previous channel must not linger over the next one.
  useEffect(() => {
    setConfirm('');
    setError(null);
  }, [target.scope, target.entityId]);

  const announce = (text: string) => {
    setConfirm(text);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirm(''), CONFIRM_MS);
  };

  const write = async (next: NotificationLevel | 'inherit') => {
    setError(null);
    try {
      if (next === 'inherit') {
        await clearTargetLevel(target, store);
        announce(`Notifications: ${resetLabel(target).replace(/^Use /, '')}`);
      } else {
        // Announce as soon as the store moved (optimistic): the icon already
        // shows the new state, and the words should arrive with it.
        const pending = setTargetLevel(target, next, store);
        announce(`Notifications: ${LEVEL_LABEL[next]}`);
        await pending;
      }
    } catch {
      setConfirm('');
      setError(WRITE_FAILED_MESSAGE);
    }
  };

  const longPress = useChannelLongPress(() => setMenuOpen(true));
  const label = controlLabel(view);

  return (
    <div className="notif-control" data-testid={`${testIdPrefix}-root`}>
      <button
        ref={buttonRef}
        type="button"
        className={className + ' notif-control-button'}
        aria-label={label}
        title={label}
        data-testid={testIdPrefix}
        data-level={view.level}
        data-inherited={view.explicit ? undefined : true}
        onClick={() => void write(nextNotificationLevel(view.level))}
        onContextMenu={(e) => {
          // Right-click, long-press on some platforms, and the keyboard's
          // context key / Shift+F10 all arrive here.
          e.preventDefault();
          setMenuOpen(true);
        }}
        onTouchStart={longPress.onTouchStart}
        onTouchEnd={longPress.onTouchEnd}
        onTouchMove={longPress.onTouchMove}
        onTouchCancel={longPress.onTouchCancel}
      >
        <LevelIcon level={view.level} size={iconSize} />
      </button>

      {/* Always mounted, so the region exists before its words change — a
          live region inserted together with its text is not announced. */}
      <span
        className="notif-control-confirm"
        role="status"
        aria-live="polite"
        data-testid={`${testIdPrefix}-confirm`}
        data-visible={confirm ? true : undefined}
      >
        {confirm}
      </span>
      {error ? (
        <span className="notif-control-error" role="alert" data-testid={`${testIdPrefix}-error`}>
          {error}
        </span>
      ) : null}

      {variant === 'menu' && menuOpen ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <span className="notif-control-anchor" aria-hidden="true" tabIndex={-1} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="channel-context-menu"
            align="end"
            sideOffset={4}
            aria-label="Notification options"
            data-testid={`${testIdPrefix}-menu`}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              buttonRef.current?.focus();
            }}
          >
            <NotificationLevelMenuGroup
              target={target}
              testIdPrefix={`${testIdPrefix}-menu`}
              onDone={() => setMenuOpen(false)}
              store={store}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {variant === 'sheet' ? (
        <NotificationLevelSheet
          open={menuOpen}
          onOpenChange={setMenuOpen}
          target={target}
          targetName={targetName}
          testIdPrefix={`${testIdPrefix}-sheet`}
          current={view.explicit ? view.level : 'inherit'}
          inheritedLabel={LEVEL_LABEL[view.inheritedLevel]}
          onChoose={(next) => {
            setMenuOpen(false);
            void write(next);
          }}
        />
      ) : null}
    </div>
  );
}

const sheetOptionClass =
  'flex w-full items-center gap-3 min-h-[44px] px-3 rounded-md text-left ' +
  'text-[15px] text-text-primary transition-colors ' +
  'duration-[var(--duration-control)] hover:bg-surface-hover ' +
  'focus-visible:outline-none focus-visible:bg-surface-hover ' +
  'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
  'aria-checked:bg-surface-selected';

interface NotificationLevelSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: NotificationTarget;
  targetName?: string;
  testIdPrefix: string;
  current: NotificationLevel | 'inherit';
  inheritedLabel: string;
  onChoose: (next: NotificationLevel | 'inherit') => void;
}

/**
 * The phone's long-press sheet: the call-sheet idiom the message actions
 * sheet uses (Radix Dialog, bottom-docked, ≥44px rows). The options are a
 * real radio group — the member sees which one holds, including "Use
 * workspace default" — and choosing one writes and dismisses.
 */
function NotificationLevelSheet({
  open,
  onOpenChange,
  target,
  targetName,
  testIdPrefix,
  current,
  inheritedLabel,
  onChoose,
}: NotificationLevelSheetProps) {
  if (!open) return null;
  const title = targetName ? `Notifications for ${targetName}` : 'Notifications';
  const options: Array<{ value: NotificationLevel | 'inherit'; label: string }> = [
    { value: 'all', label: LEVEL_LABEL.all },
    { value: 'mentions', label: LEVEL_LABEL.mentions },
    { value: 'mute', label: LEVEL_LABEL.mute },
    { value: 'inherit', label: `${resetLabel(target)} (${inheritedLabel})` },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="call-sheet-overlay"
        className="call-sheet message-actions-sheet"
        aria-label={title}
        data-testid={testIdPrefix}
      >
        <DialogTitle className="notif-sheet-title">{title}</DialogTitle>
        <div role="radiogroup" aria-label={title}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={current === option.value}
              className={sheetOptionClass}
              data-testid={`${testIdPrefix}-${option.value}`}
              onClick={() => onChoose(option.value)}
            >
              <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center text-text-muted">
                {option.value === 'inherit' ? null : <LevelIcon level={option.value} size={20} />}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
