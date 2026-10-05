/**
 * @cytale/web — once-only token reveal modal (U13 integrations).
 *
 * The `cytbot_` credential is returned EXACTLY at create/regenerate and
 * never again — this modal is that moment. Contract (binding):
 *   - Radix Dialog (focus-trapped, Esc = dismiss, focus returns to trigger);
 *   - copy affordance with copied feedback;
 *   - "shown once" copy that also states the recovery path: the row's
 *     Regenerate action mints a new once-only credential (the dismissed
 *     modal cannot be reopened).
 */

import { useEffect, useState } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

import { copyToClipboard } from './clipboard.js';

export interface TokenRevealProps {
  open: boolean;
  /** Modal heading, e.g. "Agent token" / "New agent token". */
  title: string;
  /** The once-only `cytbot_` credential. */
  token: string;
  /** Fired on dismiss (Esc / overlay / Done). */
  onDismiss: () => void;
  testId?: string;
}

export function TokenReveal({ open, title, token, onDismiss, testId = 'token-reveal' }: TokenRevealProps) {
  const [copied, setCopied] = useState(false);

  // Fresh reveal moment every time: copied state resets. Focus lands on the
  // credential itself (Radix focuses the first tabbable — the readonly
  // value, which selects its contents on focus), so Ctrl+C works at once
  // and the Copy button is one Tab away.
  useEffect(() => {
    if (open) setCopied(false);
  }, [open, token]);

  const handleCopy = async () => {
    const ok = await copyToClipboard(token);
    if (ok) setCopied(true);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onDismiss())}>
      <DialogContent
        aria-label={title}
        data-testid={testId}
        showCloseButton={false}
        overlayClassName="z-[70]"
        overlayTestId={`${testId}-overlay`}
        // The surface's own utilities ride through cn/twMerge over the
        // wrapper's baked ones; block/gap-0 neutralize the grid stack (this
        // dialog spaces itself with mt-*).
        className="block gap-0 left-1/2 top-1/2 z-[80] w-[min(92vw, 480px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface-strong p-5 shadow-2xl"
        onKeyDown={(e) => {
          // Enter on the readonly credential selects it for manual copy.
          if (e.key === 'Enter' && e.target instanceof HTMLElement && e.target.dataset.tokenValue !== undefined) {
            (e.target as HTMLInputElement).select();
          }
        }}
      >
          <DialogTitle className="text-base font-semibold text-text-primary">{title}</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-text-muted" data-testid={`${testId}-once-note`}>
            Copy this token now — it is shown only once and cannot be displayed again. If you
            lose it, use Regenerate to replace it with a new one.
          </DialogDescription>

          <div className="mt-4 flex items-center gap-2">
            <input
              readOnly
              value={token}
              data-token-value
              aria-label="Token value"
              data-testid={`${testId}-value`}
              onFocus={(e) => e.target.select()}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-text-primary"
            />
            <button
              type="button"
              onClick={handleCopy}
              data-testid={`${testId}-copy`}
              aria-live="polite"
              className="min-h-10 shrink-0 rounded-md bg-accent px-3 py-2 text-sm font-medium text-text-onaccent transition-[filter] duration-[var(--duration-control)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <div className="mt-5 flex justify-end">
            <DialogClose
              data-testid={`${testId}-done`}
              className="rounded-md border border-line px-4 py-2 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            >
              Done
            </DialogClose>
          </div>
      </DialogContent>
    </Dialog>
  );
}
