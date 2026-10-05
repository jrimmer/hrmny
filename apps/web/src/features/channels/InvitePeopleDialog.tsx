/**
 * @cytale/web — Invite People dialog (Discord parity).
 *
 * Mirrors Discord's invite flow: pick an expiry and a use cap, generate the
 * link, copy it. The link points at the hash-routed invite landing
 * (`/#/invite/{code}`), which resolves the code publicly and walks the
 * recipient through join (or login-or-register first, per flow F1).
 *
 * The server caps invite lifetimes at positive seconds (no "never"), so
 * the expiry options are honest to that contract; 10 minutes is the
 * server's own default.
 */

import { useEffect, useRef, useState } from 'react';

import { copyToClipboard } from '../settings/clipboard.js';

import { dialogErrorMessage } from './dialogError.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

export interface CreateInviteInput {
  maxAgeSeconds: number;
  maxUses: number;
}

export interface InvitePeopleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mints an invite in the active workspace; rejects with ApiError. */
  onCreateInvite: (input: CreateInviteInput) => Promise<{ code: string }>;
}

const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '600', label: '10 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '86400', label: '1 day' },
  { value: '604800', label: '7 days' },
];

const MAX_USES_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: 'No limit' },
  { value: '1', label: '1 use' },
  { value: '5', label: '5 uses' },
  { value: '10', label: '10 uses' },
  { value: '25', label: '25 uses' },
];

/** Full invite URL for a code, against the hash-routed landing. */
export function inviteUrl(code: string): string {
  return `${globalThis.location.origin}${globalThis.location.pathname}#/invite/${code}`;
}

export function InvitePeopleDialog({
  open,
  onOpenChange,
  onCreateInvite,
}: InvitePeopleDialogProps) {
  const [expiry, setExpiry] = useState('86400');
  const [maxUses, setMaxUses] = useState('0');
  const [code, setCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fresh dialog every open; never leave a copy timer behind.
  useEffect(() => {
    if (open) {
      setExpiry('86400');
      setMaxUses('0');
      setCode(null);
      setPending(false);
      setError(null);
      setCopied(false);
    }
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, [open]);

  const generate = async () => {
    setPending(true);
    setError(null);
    try {
      const invite = await onCreateInvite({
        maxAgeSeconds: Number(expiry),
        maxUses: Number(maxUses),
      });
      setCode(invite.code);
      setCopied(false);
    } catch (err) {
      setError(
        dialogErrorMessage(
          err,
          "You don't have permission to create invites in this workspace. Ask a workspace admin for an invite link.",
          'Could not create an invite. Try again.',
        ),
      );
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!code) return;
    const ok = await copyToClipboard(inviteUrl(code));
    // jsdom/fallback may honestly fail — only claim success after a write.
    if (!ok) return;
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o);
      }}
    >
      {/* showCloseButton={false}: the house ✕ below keeps its own styling
          and pending-disable; the wrapper's default close would duplicate. */}
      <DialogContent
        className="modal-panel"
        showCloseButton={false}
        aria-describedby={undefined}
          data-testid="invite-dialog"
        >
          <DialogTitle className="modal-title">Invite people</DialogTitle>
          <DialogClose className="modal-close" aria-label="Close" disabled={pending}>
            ✕
          </DialogClose>
          <p className="modal-explainer">
            Anyone with this link can join your workspace while it's valid.
          </p>

          <label className="modal-label" htmlFor="invite-expiry-select">
            Expiry
          </label>
          <select
            id="invite-expiry-select"
            data-testid="invite-expiry"
            className="modal-input"
            value={expiry}
            disabled={pending}
            onChange={(e) => setExpiry(e.target.value)}
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <label className="modal-label" htmlFor="invite-max-uses-select">
            Max uses
          </label>
          <select
            id="invite-max-uses-select"
            data-testid="invite-max-uses"
            className="modal-input"
            value={maxUses}
            disabled={pending}
            onChange={(e) => setMaxUses(e.target.value)}
          >
            {MAX_USES_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          {error ? (
            <p role="alert" data-testid="invite-error" className="modal-error">
              {error}
            </p>
          ) : null}

          {code ? (
            <>
              <label className="modal-label" htmlFor="invite-link-input">
                Invite link
              </label>
              <div className="invite-link-row">
                <input
                  id="invite-link-input"
                  data-testid="invite-link"
                  className="modal-input"
                  value={inviteUrl(code)}
                  readOnly
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  className="modal-btn-primary"
                  data-testid="invite-copy"
                  onClick={() => void copy()}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="modal-btn-secondary"
                  data-testid="invite-regenerate"
                  disabled={pending}
                  onClick={() => void generate()}
                >
                  {pending ? 'Generating…' : 'Generate a new link'}
                </button>
              </div>
            </>
          ) : (
            <div className="modal-actions">
              <button
                type="button"
                className="modal-btn-secondary"
                data-testid="invite-cancel"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn-primary"
                data-testid="invite-generate"
                disabled={pending}
                onClick={() => void generate()}
              >
                {pending ? 'Generating…' : 'Generate invite link'}
              </button>
            </div>
          )}
      </DialogContent>
    </Dialog>
  );
}
