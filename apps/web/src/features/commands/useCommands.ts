/**
 * @cytale/web — workspace commands hook (bots plan U9).
 *
 * Fetches the active workspace's registered application commands for the
 * composer slash palette (`GET /workspaces/{id}/commands`, member-gated).
 * The fetch is scheduled DEBOUNCED on open — a stray "/" keystroke that
 * vanishes before the debounce elapses never hits the wire; a loaded roster
 * is cached for the hook's lifetime (registrations are rare; retry re-fetches
 * on error only).
 *
 * States-first per UX_SPEC §9: loading (debounce+fetch in flight), empty
 * (ready with zero commands — distinct from error), error (role=alert with
 * retry, forbidden flagged for the permission-denied copy), offline (owned
 * by the composer surface — loads are suppressed while offline).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, type ApplicationCommand } from '@cytale/api-client';

import { api } from '../auth/session.js';

/** Debounce before the open-triggered fetch hits the wire. */
const COMMANDS_FETCH_DEBOUNCE_MS = 250;

export type CommandsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; commands: ApplicationCommand[] }
  | { status: 'error'; error: string; /** 403 member-gate → permission-denied copy. */ forbidden: boolean };

export interface UseCommands {
  /** Current load state (commands ride `ready`). */
  readonly state: CommandsState;
  /** Debounced load; no-op when already ready/loading or no workspace. */
  load(): void;
  /** Immediate re-fetch (retry affordance). */
  retry(): void;
}

export function useCommands(workspaceId?: string | null): UseCommands {
  const [state, setState] = useState<CommandsState>({ status: 'idle' });

  // Mirror state into a ref so `load()` can consult it without re-creating
  // the callback identity the composer depends on.
  const stateRef = useRef(state);
  stateRef.current = state;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  // Workspace switch invalidates the cache wholesale.
  useEffect(() => {
    setState({ status: 'idle' });
  }, [workspaceId]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const fetchCommands = useCallback(async () => {
    if (workspaceId == null || inFlightRef.current) return;
    inFlightRef.current = true;
    setState({ status: 'loading' });
    try {
      const commands = await api.listWorkspaceCommands(workspaceId);
      setState({ status: 'ready', commands });
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        forbidden: err instanceof ApiError && err.status === 403,
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [workspaceId]);

  const load = useCallback(() => {
    const s = stateRef.current;
    if (workspaceId == null || s.status === 'ready' || s.status === 'loading') return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void fetchCommands();
    }, COMMANDS_FETCH_DEBOUNCE_MS);
  }, [fetchCommands, workspaceId]);

  const retry = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void fetchCommands();
  }, [fetchCommands]);

  return { state, load, retry };
}

/** Client-side name filter for the palette (case-insensitive substring). */
export function filterCommands(
  commands: ApplicationCommand[],
  query: string,
): ApplicationCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.name.toLowerCase().includes(q));
}
