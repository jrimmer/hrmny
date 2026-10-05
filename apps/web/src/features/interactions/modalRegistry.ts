/**
 * @cytale/web — which bot modals THIS tab should open (#30).
 *
 * A bot answers an interaction with a modal (callback type 9); the server
 * delivers it as `InteractionModal` to every session of the invoking user.
 * Only the tab that made the interaction should open the form — a second
 * device popping a dialog for a click it never made would be startling, and
 * a submit from there would race the real one.
 *
 * The tab knows its interactions by the `interaction_id` its click/command
 * POST got back (202). The modal can outrun that response: the server fans
 * the interaction to the bot BEFORE answering the POST (emit-before-ack), so
 * a fast bot's modal may land first. Early modals wait here briefly for their
 * id to be claimed; unclaimed ones expire (they belong to another tab).
 *
 * Module-level store (the useComponentClick idiom): it outlives any one
 * component, and the gateway listener and the host read the same one.
 */

import { createStore } from 'zustand/vanilla';

import type { InteractionModal } from '@cytale/protocol';

/** How long an unclaimed modal waits for its interaction's 202. */
export const EARLY_MODAL_TTL_MS = 10_000;
/** How long a claimed interaction id stays eligible (the token's life). */
export const CLAIM_TTL_MS = 15 * 60 * 1000;

export interface ModalRegistryState {
  /** The modals this tab should show, oldest first (the host shows [0]). */
  queue: InteractionModal[];
}

export const modalStore = createStore<ModalRegistryState>()(() => ({ queue: [] }));

interface Claim {
  /** Called when this interaction's modal opens — a modal IS the bot's
   * response, so the invoking control's pending state resolves. */
  onOpen: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const claims = new Map<string, Claim>();
const early = new Map<string, { modal: InteractionModal; timer: ReturnType<typeof setTimeout> }>();

function open(modal: InteractionModal): void {
  const claim = claims.get(modal.interaction_id);
  if (claim) {
    clearTimeout(claim.timer);
    claims.delete(modal.interaction_id);
    claim.onOpen();
  }
  modalStore.setState((s) =>
    s.queue.some((m) => m.interaction_id === modal.interaction_id)
      ? {}
      : { queue: [...s.queue, modal] },
  );
}

/**
 * This tab made interaction `interactionId` (its POST returned it). If its
 * modal already arrived, it opens now; otherwise it opens when it does.
 */
export function claimInteraction(interactionId: string, onOpen: () => void = () => {}): void {
  const waiting = early.get(interactionId);
  if (waiting) {
    clearTimeout(waiting.timer);
    early.delete(interactionId);
    onOpen();
    open(waiting.modal);
    return;
  }
  const prior = claims.get(interactionId);
  if (prior) clearTimeout(prior.timer);
  claims.set(interactionId, {
    onOpen,
    timer: setTimeout(() => claims.delete(interactionId), CLAIM_TTL_MS),
  });
}

/** A modal arrived on the gateway. */
export function receiveModal(modal: InteractionModal): void {
  if (claims.has(modal.interaction_id)) {
    open(modal);
    return;
  }
  const prior = early.get(modal.interaction_id);
  if (prior) clearTimeout(prior.timer);
  early.set(modal.interaction_id, {
    modal,
    timer: setTimeout(() => early.delete(modal.interaction_id), EARLY_MODAL_TTL_MS),
  });
}

/** Close the front modal (cancelled or submitted). */
export function closeModal(interactionId: string): void {
  modalStore.setState((s) => ({ queue: s.queue.filter((m) => m.interaction_id !== interactionId) }));
}

/** Test seam: forget everything (module singletons otherwise persist). */
export function resetModalRegistry(): void {
  for (const c of claims.values()) clearTimeout(c.timer);
  for (const e of early.values()) clearTimeout(e.timer);
  claims.clear();
  early.clear();
  modalStore.setState({ queue: [] });
}
