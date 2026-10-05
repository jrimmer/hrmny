/**
 * @cytale/web — the bot answered one of this tab's interactions.
 *
 * The server sends `InteractionSuccess` (Discord's INTERACTION_SUCCESS) to
 * the invoking user's sessions at the bot's FIRST answer of any kind: a
 * reply (4), a deferred reply (5), a deferred update (6), an update of the
 * card (7), a modal (9), or a followup posted without an initial response.
 * It is the exact "answered" signal — a deferred ack changes nothing in the
 * message store, so watching the store alone cannot see it.
 *
 * A pending control registers what identifies its interaction here: the
 * `nonce` its POST sent (known BEFORE the POST answers — the server fans the
 * interaction to the bot first, so a fast bot's answer can outrun the 202),
 * then the `interaction_id` the 202 returns. Whichever the event names
 * first wins, once.
 *
 * DOM-free and import-light on purpose: the session composition root feeds
 * it from the gateway (a preprocessor), and it must not import the session
 * back.
 */

import type { InteractionSuccess } from '@cytale/protocol';

type OnAnswer = (answer: InteractionSuccess) => void;

/** nonce or interaction id → the waiting control's callback. */
const waiting = new Map<string, OnAnswer>();

/** Wait for the answer to the interaction `token` names (a nonce or an
 * interaction id). Registering both for one control is the normal case. */
export function awaitAnswer(token: string, onAnswer: OnAnswer): void {
  waiting.set(token, onAnswer);
}

/** Stop waiting on `tokens` (the control resolved, failed or was dismissed). */
export function forgetAnswers(tokens: Iterable<string>): void {
  for (const token of tokens) waiting.delete(token);
}

/** An `InteractionSuccess` payload arrived. Returns whether a waiting
 * control took it. */
export function receiveInteractionSuccess(answer: InteractionSuccess): boolean {
  const byNonce = answer.nonce != null ? waiting.get(answer.nonce) : undefined;
  const onAnswer = byNonce ?? waiting.get(answer.interaction_id);
  if (!onAnswer) return false;
  if (answer.nonce != null) waiting.delete(answer.nonce);
  waiting.delete(answer.interaction_id);
  onAnswer(answer);
  return true;
}

function isInteractionSuccess(d: unknown): d is InteractionSuccess {
  if (d === null || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return typeof o.interaction_id === 'string' && (o.nonce === null || typeof o.nonce === 'string');
}

/** The gateway preprocessor: route an `InteractionSuccess` dispatch frame.
 * Replays are harmless — an answered interaction has nothing waiting. */
export function routeInteractionSuccessFrame(frame: unknown): void {
  if (frame === null || typeof frame !== 'object') return;
  const f = frame as { op?: unknown; t?: unknown; d?: unknown };
  if (f.op !== 0 || f.t !== 'InteractionSuccess' || !isInteractionSuccess(f.d)) return;
  receiveInteractionSuccess(f.d);
}

let nonceSeq = 0;

/** A fresh interaction nonce (1–64 chars; unique per tab, random across
 * tabs). Not `crypto.randomUUID`: that is missing outside secure contexts,
 * and a self-hosted server on a LAN address over plain http is one. */
export function newInteractionNonce(): string {
  nonceSeq += 1;
  const random = Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${nonceSeq.toString(36)}-${random}`;
}

/** Test seam: forget everything (module singletons otherwise persist). */
export function resetInteractionAnswers(): void {
  waiting.clear();
  nonceSeq = 0;
}
