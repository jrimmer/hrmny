/**
 * @cytale/web — "Remind me…" (#54 U7): set, see, change and cancel a reminder
 * on one message.
 *
 * One panel, two hosts: a popover off the desktop hover toolbar (the
 * ReactionPicker pattern — outside press and Escape close it, focus returns to
 * the trigger), and a dialog opened from the touch actions sheet.
 *
 * Presets first (the common cases never open a date picker), a custom date and
 * time second. Presets resolve to absolute instants in the browser's own zone
 * (KTD8). A pending reminder shows its time on the trigger and in the panel,
 * where the same action changes it (a re-set, never a second reminder) or
 * cancels it. States: idle, submitting (actions disabled), error (the server's
 * reason, role=alert), offline (the trigger is disabled with a title).
 */

import { useEffect, useRef, useState } from 'react';

import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../components/shadcn/dialog.js';
import { formatReminder, REMINDER_PRESETS, useReminder } from './useMarks.js';

/** An alarm-clock glyph — monochrome, in the toolbar's SVG set. */
export const REMIND_PATH =
  'M12 4a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 16a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm.5-11H11v5l4.25 2.52.75-1.23-3.5-2.08V9zM7.88 3.39 6.6 1.86 2 5.71l1.29 1.53 4.59-3.85zM22 5.72l-4.6-3.86-1.29 1.53 4.6 3.86L22 5.72z';

interface PanelProps {
  channelId: string;
  messageId: string;
  /** Called after a successful set/cancel so the host can close. */
  onDone: () => void;
}

/** Local `datetime-local` value for a Date (the input has no zone). */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MarkPickerPanel({ channelId, messageId, onDone }: PanelProps) {
  const reminder = useReminder(channelId, messageId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));

  const run = async (op: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await op();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The reminder could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const setAt = (at: Date): void => {
    if (!(at.getTime() > Date.now())) {
      setError('Pick a time in the future.');
      return;
    }
    void run(() => reminder.set(at));
  };

  return (
    <div className="flex w-64 flex-col gap-1 p-1" data-testid="mark-picker-panel">
      {reminder.dueAt ? (
        <p className="px-2 pb-1 text-xs text-text-muted" data-testid="mark-picker-pending">
          Reminder set for <span className="text-text">{formatReminder(reminder.dueAt)}</span>
        </p>
      ) : null}
      <div role="group" aria-label="Remind me" className="flex flex-col">
        {REMINDER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="rounded-md px-2 py-1.5 text-left text-sm text-text hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-50"
            data-testid="mark-preset"
            data-preset={preset.id}
            disabled={busy}
            onClick={() => setAt(preset.at(new Date()))}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <form
        className="flex items-center gap-1 border-t border-line px-1 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          const at = new Date(custom);
          if (Number.isNaN(at.getTime())) {
            setError('Pick a date and time.');
            return;
          }
          setAt(at);
        }}
      >
        <label className="sr-only" htmlFor={`mark-custom-${messageId}`}>
          Custom date and time
        </label>
        <input
          id={`mark-custom-${messageId}`}
          type="datetime-local"
          className="modal-input min-w-0 flex-1 text-xs"
          value={custom}
          disabled={busy}
          onChange={(e) => setCustom(e.target.value)}
          data-testid="mark-custom"
        />
        <button type="submit" className="modal-btn-primary px-2 text-xs" disabled={busy} data-testid="mark-custom-set">
          Set
        </button>
      </form>
      {reminder.dueAt ? (
        <button
          type="button"
          className="mt-1 rounded-md px-2 py-1.5 text-left text-sm text-text-muted hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:opacity-50"
          data-testid="mark-cancel"
          disabled={busy}
          onClick={() => void run(() => reminder.cancel())}
        >
          Cancel reminder
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="px-2 pt-1 text-xs text-danger" data-testid="mark-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface MarkPickerProps {
  channelId: string;
  messageId: string;
  /** Offline: the trigger is disabled with a title saying why. */
  disabled?: boolean;
  /** The toolbar's button class, so the trigger sits in its row exactly. */
  buttonClassName: string;
  icon: (d: string, extra?: string) => React.ReactNode;
}

/** The hover-toolbar trigger + popover. */
export function MarkPicker({ channelId, messageId, disabled = false, buttonClassName, icon }: MarkPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { dueAt } = useReminder(channelId, messageId);

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

  const label = dueAt ? `Reminder set for ${formatReminder(dueAt)} — change or cancel` : 'Remind me about this message';

  return (
    <div
      className="relative inline-flex"
      ref={rootRef}
      data-testid="mark-picker-root"
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`${buttonClassName} ${dueAt ? 'text-accent' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={disabled ? 'You are offline — reminders are unavailable until reconnection' : label}
        data-testid="action-remind"
        data-pending={dueAt ? 'true' : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {icon(REMIND_PATH)}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Remind me"
          className="absolute right-0 top-full z-30 mt-1 popover"
          data-testid="mark-picker"
        >
          <MarkPickerPanel channelId={channelId} messageId={messageId} onDone={close} />
        </div>
      ) : null}
    </div>
  );
}

/** The touch host: the same panel in a dialog (opened from the actions sheet). */
export function MarkPickerDialog({
  channelId,
  messageId,
  open,
  onOpenChange,
}: {
  channelId: string;
  messageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The house ✕ every other modal-panel dialog wears (ConfirmDialog,
          the channel dialogs): the wrapper's default close is a lucide icon
          at a different inset, opacity and focus style. */}
      <DialogContent
        className="modal-panel"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="mark-picker-dialog"
      >
        <DialogTitle className="modal-title">Remind me</DialogTitle>
        <DialogClose className="modal-close" aria-label="Close">
          ✕
        </DialogClose>
        <MarkPickerPanel channelId={channelId} messageId={messageId} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
