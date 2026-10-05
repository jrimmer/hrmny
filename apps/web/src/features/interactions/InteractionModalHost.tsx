/**
 * @cytale/web — the bot-modal form (#30).
 *
 * Listens for `InteractionModal` on the session gateway, hands each to the
 * registry (which decides whether THIS tab made that interaction), and
 * renders the front of the registry's queue as a form in the house dialog
 * shell — focus-trapped by Radix, Escape and ✕ cancel.
 *
 * Contract with the server (Interactions.submit_modal/4), mirrored here so a
 * member learns about a problem before sending:
 *  - every input answers once, in the modal's order;
 *  - `required` inputs are non-empty; lengths are within min/max (counted in
 *    user-perceived characters, like the server's graphemes);
 *  - a SHORT input is one line (a single-line <input>; Enter submits).
 *
 * States: submitting (actions disabled), offline (submit disabled with a
 * note — nothing can be sent), and errors — `validation_failed` keeps the
 * form open and editable; `modal_unavailable` (expired / already sent) and
 * 410 (the bot is gone) are terminal: the only action left is Close.
 * Cancelling sends nothing (Discord parity).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { ApiError } from '@cytale/api-client';
import type { GatewayClient } from '@cytale/gateway-client';
import type { InteractionModal, ModalTextInput } from '@cytale/protocol';

import { useOnlineStatus } from '../../app/pwa/useOnlineStatus.js';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../components/shadcn/dialog.js';
import { api, session } from '../auth/session.js';
import { closeModal, modalStore, receiveModal } from './modalRegistry.js';

/** User-perceived characters (grapheme clusters), matching the server. */
function charCount(value: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) n += 1;
    return n;
  }
  return [...value].length;
}

/** The client-side twin of the server's per-answer rule. `null` = valid. */
export function fieldError(input: ModalTextInput, value: string): string | null {
  const n = charCount(value);
  if (input.style === 1 && /[\r\n]/.test(value)) return 'Keep this to a single line.';
  if (n === 0) return input.required ? 'This field is required.' : null;
  if (n < input.min_length) return `Use at least ${input.min_length} characters.`;
  if (n > input.max_length) return `Use at most ${input.max_length} characters.`;
  return null;
}

function inputsOf(modal: InteractionModal): ModalTextInput[] {
  return modal.components.map((row) => row.components[0]);
}

type SubmitState =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string; terminal: boolean };

export interface InteractionModalHostProps {
  /** Injectable for tests; defaults to the live session gateway. */
  gateway?: GatewayClient | null;
}

export function InteractionModalHost({ gateway }: InteractionModalHostProps) {
  const gw = gateway === undefined ? session.getGateway() : gateway;
  useEffect(() => {
    if (!gw) return;
    return gw.on('InteractionModal', receiveModal);
  }, [gw]);

  const queue = useSyncExternalStore(
    modalStore.subscribe,
    () => modalStore.getState().queue,
    () => modalStore.getState().queue,
  );
  const modal = queue[0];
  // Keyed by interaction: a new modal starts from a clean form.
  return modal ? <ModalForm key={modal.interaction_id} modal={modal} /> : null;
}

function ModalForm({ modal }: { modal: InteractionModal }) {
  const inputs = inputsOf(modal);
  const online = useOnlineStatus();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(inputs.map((i) => [i.custom_id, i.value ?? ''])),
  );
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<SubmitState>({ kind: 'editing' });
  const submitting = state.kind === 'submitting';
  const terminal = state.kind === 'error' && state.terminal;

  const errors = Object.fromEntries(
    inputs.map((i) => [i.custom_id, fieldError(i, values[i.custom_id] ?? '')]),
  );
  const valid = inputs.every((i) => errors[i.custom_id] === null);

  const close = (): void => closeModal(modal.interaction_id);

  const submit = async (): Promise<void> => {
    // Show every field's problem at once rather than one per attempt.
    setTouched(Object.fromEntries(inputs.map((i) => [i.custom_id, true])));
    if (!valid || submitting || terminal || !online) return;
    setState({ kind: 'submitting' });
    try {
      await api.submitModal({
        kind: 'modal_submit',
        interaction_id: modal.interaction_id,
        custom_id: modal.custom_id,
        components: inputs.map((i) => ({
          type: 1,
          components: [{ type: 4, custom_id: i.custom_id, value: values[i.custom_id] ?? '' }],
        })),
      });
      close();
    } catch (err) {
      if (err instanceof ApiError && (err.key === 'modal_unavailable' || err.status === 410)) {
        setState({
          kind: 'error',
          terminal: true,
          message:
            err.status === 410
              ? 'The app behind this form is no longer active.'
              : 'This form has expired or was already sent.',
        });
      } else {
        setState({
          kind: 'error',
          terminal: false,
          message: err instanceof Error ? err.message : 'The form could not be sent. Try again.',
        });
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !submitting) close();
      }}
    >
      <DialogContent
        className="modal-panel"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="interaction-modal"
        data-custom-id={modal.custom_id}
      >
        <DialogTitle className="modal-title">{modal.title}</DialogTitle>
        <DialogClose className="modal-close" aria-label="Cancel" disabled={submitting}>
          ✕
        </DialogClose>

        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {inputs.map((input, index) => {
            const id = `interaction-modal-field-${index}`;
            const errorId = `${id}-error`;
            const value = values[input.custom_id] ?? '';
            const error = touched[input.custom_id] ? errors[input.custom_id] : null;
            const common = {
              id,
              className: 'modal-input',
              value,
              placeholder: input.placeholder,
              required: input.required,
              disabled: submitting || terminal,
              'aria-invalid': error ? true : undefined,
              'aria-describedby': error ? errorId : undefined,
              'data-testid': 'interaction-modal-field',
              'data-custom-id': input.custom_id,
              autoFocus: index === 0,
              onBlur: () => setTouched((t) => ({ ...t, [input.custom_id]: true })),
            } as const;
            return (
              <div key={input.custom_id} className="mb-3">
                <label className="modal-label" htmlFor={id}>
                  {input.label}
                  {input.required ? null : <span className="modal-label-optional"> (optional)</span>}
                </label>
                {input.style === 1 ? (
                  <input
                    {...common}
                    type="text"
                    onChange={(e) => setValues((v) => ({ ...v, [input.custom_id]: e.target.value }))}
                  />
                ) : (
                  <textarea
                    {...common}
                    rows={4}
                    onChange={(e) => setValues((v) => ({ ...v, [input.custom_id]: e.target.value }))}
                  />
                )}
                <div className="flex justify-between text-xs text-text-muted">
                  <span id={errorId} role={error ? 'alert' : undefined} className={error ? 'text-danger' : ''}>
                    {error ?? ''}
                  </span>
                  <span aria-hidden>
                    {charCount(value)}/{input.max_length}
                  </span>
                </div>
              </div>
            );
          })}

          {!online ? (
            <p role="status" className="modal-explainer" data-testid="interaction-modal-offline">
              You're offline — the form will be sendable once you reconnect.
            </p>
          ) : null}
          {state.kind === 'error' ? (
            <p role="alert" className="modal-error" data-testid="interaction-modal-error">
              {state.message}
            </p>
          ) : null}

          <div className="modal-actions">
            <DialogClose asChild>
              <button
                type="button"
                className="modal-btn-secondary"
                data-testid="interaction-modal-cancel"
                disabled={submitting}
              >
                {terminal ? 'Close' : 'Cancel'}
              </button>
            </DialogClose>
            {terminal ? null : (
              <button
                type="submit"
                className="modal-btn-primary"
                data-testid="interaction-modal-submit"
                disabled={submitting || !online}
              >
                {submitting ? 'Sending…' : 'Submit'}
              </button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
