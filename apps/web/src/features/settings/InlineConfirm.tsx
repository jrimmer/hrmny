/**
 * @cytale/web — inline destructive confirmation (U13 integrations).
 *
 * The repo's no-native-dialogs pattern: a two-step button that expands, in
 * place, into consequence copy + Cancel/Confirm. Dismissing (Cancel, focus
 * leave-by-Tab, Esc) leaves state exactly as it was; only the explicit
 * Confirm executes. Arming announces the consequence via role="alert" and
 * moves focus to Cancel so keyboard users read the stakes before the
 * destructive button is reachable.
 */

import { useEffect, useRef, useState } from 'react';

export interface InlineConfirmProps {
  /** Trigger label, e.g. "Revoke". */
  label: string;
  /** Consequence copy shown when armed, e.g. "This disconnects the bot immediately". */
  consequence: string;
  /** Armed-state confirm button label (defaults to the trigger label). */
  confirmLabel?: string;
  /** Danger styling for irreversible actions (revoke / delete). */
  tone?: 'danger' | 'default';
  /** Disable the trigger (e.g. offline — destructive actions disabled). */
  disabled?: boolean;
  disabledReason?: string;
  onConfirm: () => void;
  /** data-testid prefix; children get `-trigger`, `-consequence`, `-cancel`, `-confirm`. */
  testId: string;
}

export function InlineConfirm({
  label,
  consequence,
  confirmLabel,
  tone = 'default',
  disabled = false,
  disabledReason,
  onConfirm,
  testId,
}: InlineConfirmProps) {
  const [armed, setArmed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Announce + focus the safe path the moment the confirm arms.
  useEffect(() => {
    if (armed) cancelRef.current?.focus();
  }, [armed]);

  const confirmBtn =
    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-[var(--duration-control)] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

  if (!armed) {
    return (
      <button
        type="button"
        className={
          'rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ' +
          'duration-[var(--duration-control)] focus-visible:outline-none ' +
          'focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ' +
          (tone === 'danger'
            ? 'border-danger/40 text-danger hover:bg-danger/10'
            : 'border-line text-text hover:bg-surface-hover hover:text-text-primary') +
          (disabled ? ' cursor-not-allowed opacity-50 hover:bg-transparent' : '')
        }
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        data-testid={`${testId}-trigger`}
        aria-label={label}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <span
      className="inline-flex flex-wrap items-center gap-2"
      data-testid={`${testId}-armed`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setArmed(false);
        }
      }}
    >
      <span
        role="alert"
        data-testid={`${testId}-consequence`}
        className={tone === 'danger' ? 'text-sm text-danger' : 'text-sm text-warning'}
      >
        {consequence}
      </span>
      <button
        ref={cancelRef}
        type="button"
        className={
          confirmBtn + ' border border-line text-text hover:bg-surface-hover hover:text-text-primary'
        }
        data-testid={`${testId}-cancel`}
        onClick={() => setArmed(false)}
      >
        Cancel
      </button>
      <button
        type="button"
        className={
          confirmBtn +
          (tone === 'danger'
            ? ' bg-danger text-text-onaccent hover:brightness-110'
            : ' bg-accent text-text-onaccent hover:brightness-110')
        }
        data-testid={`${testId}-confirm`}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel ?? label}
      </button>
    </span>
  );
}
