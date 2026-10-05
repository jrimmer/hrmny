/**
 * @cytale/web — interaction invocation hook (bots plan U9).
 *
 * Owns the invocation half of the composer command surface:
 *  - `invoke` POSTs `/interactions` and holds a bounded pending state (the
 *    202 only means the bot's session was notified — it is NOT the response).
 *  - The bot's response arrives later as a NORMAL message via the gateway;
 *    pending clears when a new message authored by the command's bot
 *    principal (`application_id`) lands in the target channel's store slice.
 *    No in-transcript placeholder ever exists, so there is nothing to clean
 *    up if it arrives after the deadline.
 *  - ~10s client timeout → the named "no response" error with re-invoke.
 *    The server keeps the 15-min token life; a late-arriving response still
 *    renders as a normal message while the (dismissable) error simply notes
 *    it may still be processing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, type ApplicationCommand } from '@cytale/api-client';
import type { StateStore } from '@cytale/state';
import { defaultStore } from '@cytale/state';

import { api } from '../auth/session.js';
import { claimInteraction } from '../interactions/modalRegistry.js';

/** Client-side UX deadline for the bot's response (server keeps 15 min). */
export const INTERACTION_TIMEOUT_MS = 10_000;

export type InteractionStatus =
  | { kind: 'idle' }
  | {
      kind: 'pending';
      command: ApplicationCommand;
      channelId: string;
      options: Record<string, unknown>;
    }
  | {
      kind: 'no-response';
      command: ApplicationCommand;
      channelId: string;
      options: Record<string, unknown>;
    }
  | {
      kind: 'error';
      command: ApplicationCommand;
      channelId: string;
      options: Record<string, unknown>;
      error: string;
      /** 403 (no send right / membership) → permission-denied copy. */
      forbidden: boolean;
    };

export interface UseInteraction {
  readonly status: InteractionStatus;
  /** Invoke a command in a channel with filled options. */
  invoke(command: ApplicationCommand, channelId: string, options: Record<string, unknown>): Promise<void>;
  /** Re-run the last invocation ("no response" recovery affordance). */
  reinvoke(): Promise<void>;
  /** Clear a no-response/error state back to idle. */
  dismiss(): void;
}

function toError(err: unknown): { message: string; forbidden: boolean } {
  if (err instanceof ApiError) {
    return { message: err.message, forbidden: err.status === 403 };
  }
  return { message: err instanceof Error ? err.message : String(err), forbidden: false };
}

export function useInteraction(store: StateStore = defaultStore): UseInteraction {
  const [status, setStatus] = useState<InteractionStatus>({ kind: 'idle' });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRef = useRef<{
    command: ApplicationCommand;
    channelId: string;
    options: Record<string, unknown>;
  } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  // Response watch while pending: any NEW message in the target channel
  // authored by the command's bot principal completes the interaction.
  useEffect(() => {
    if (status.kind !== 'pending') return;
    const { command, channelId } = status;
    const known = new Set(
      (store.getState().messagesByChannel[channelId]?.items ?? []).map((m) => m.id),
    );
    const check = () => {
      const items = store.getState().messagesByChannel[channelId]?.items ?? [];
      const responded = items.some(
        (m) => !known.has(m.id) && m.author_id === command.application_id,
      );
      if (responded) {
        clearTimer();
        setStatus({ kind: 'idle' }); // the message itself renders via the store
      }
    };
    check(); // the response may have landed before this effect mounted
    return store.subscribe(check);
  }, [status, store, clearTimer]);

  const invoke = useCallback(
    async (
      command: ApplicationCommand,
      channelId: string,
      options: Record<string, unknown>,
    ) => {
      clearTimer();
      lastRef.current = { command, channelId, options };
      setStatus({ kind: 'pending', command, channelId, options });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setStatus((s) =>
          s.kind === 'pending'
            ? { kind: 'no-response', command, channelId, options }
            : s,
        );
      }, INTERACTION_TIMEOUT_MS);
      try {
        const res = await api.invokeInteraction({
          command_id: command.id,
          channel_id: channelId,
          options: Object.keys(options).length > 0 ? options : undefined,
        });
        // The bot may answer with a modal (#30): it opens here, and opening
        // is the response — the pending state resolves.
        if (res?.interaction_id) {
          claimInteraction(res.interaction_id, () => {
            clearTimer();
            setStatus((s) => (s.kind === 'pending' || s.kind === 'no-response' ? { kind: 'idle' } : s));
          });
        }
        // Stay pending: 202/201 only confirms fan-out to the bot's session.
        // The response watch (or the timeout above) resolves the UX state.
      } catch (err) {
        const { message, forbidden } = toError(err);
        clearTimer();
        setStatus((s) =>
          s.kind === 'pending' || s.kind === 'no-response'
            ? { kind: 'error', command, channelId, options, error: message, forbidden }
            : s,
        );
      }
    },
    [clearTimer],
  );

  const reinvoke = useCallback(async () => {
    const last = lastRef.current;
    if (!last) return;
    await invoke(last.command, last.channelId, last.options);
  }, [invoke]);

  const dismiss = useCallback(() => {
    clearTimer();
    setStatus({ kind: 'idle' });
  }, [clearTimer]);

  return { status, invoke, reinvoke, dismiss };
}
