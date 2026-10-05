/**
 * @cytale/web — the member's own message marks (#54 U7).
 *
 * v1 carries one kind, `snooze` ("Remind me…"). The store is MODULE-level
 * (the useComponentClick idiom): react-virtuoso unmounts rows that scroll out
 * of the window, and a row that comes back must still show its pending time.
 *
 * - Loaded once per session from `GET /users/@me/marks` (the owner's pending
 *   list — identifiers and times only).
 * - Set / cancel are OPTIMISTIC with rollback: the action shows the new state
 *   at once, and a refusal (past instant, cap reached, a message no longer
 *   readable) restores the previous one and surfaces the server's reason.
 * - A mark whose due time has passed is no longer "pending" to the UI: the
 *   reminder has fired (or will within one sweep), and the unread state is
 *   what shows it from then on.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { createStore } from 'zustand/vanilla';

import { ApiError } from '@cytale/api-client';

import { api } from '../auth/session.js';

export const REMINDER_KIND = 'snooze';

interface MarksState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** `${channelId} ${messageId}` → ISO due instant. */
  dueByKey: Record<string, string>;
}

const marksStore = createStore<MarksState>()(() => ({ status: 'idle', dueByKey: {} }));

const keyOf = (channelId: string, messageId: string): string => `${channelId} ${messageId}`;

function ensureLoaded(): void {
  if (marksStore.getState().status !== 'idle') return;
  marksStore.setState({ status: 'loading' });
  api
    .listMarks()
    .then((marks) => {
      const dueByKey: Record<string, string> = {};
      for (const m of marks) {
        if (m.kind === REMINDER_KIND && m.due_at) dueByKey[keyOf(m.channel_id, m.message_id)] = m.due_at;
      }
      // Local writes made while loading win over the snapshot.
      marksStore.setState((s) => ({ status: 'ready', dueByKey: { ...dueByKey, ...s.dueByKey } }));
    })
    .catch(() => marksStore.setState({ status: 'error' }));
}

function setDue(key: string, due: string | undefined): void {
  marksStore.setState((s) => {
    const dueByKey = { ...s.dueByKey };
    if (due === undefined) delete dueByKey[key];
    else dueByKey[key] = due;
    return { dueByKey };
  });
}

/** The reason a refusal gives the member (the server's words when it has them). */
export function reminderError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This message can't be reached anymore.";
    if (err.status === 409) return 'You have too many pending reminders.';
    return err.message || 'The reminder could not be saved.';
  }
  return 'The reminder could not be saved. Check your connection and try again.';
}

export interface UseReminder {
  /** The pending reminder's instant, or null. */
  readonly dueAt: Date | null;
  /** Set or re-set (one reminder per message). Rejects with a member-facing reason. */
  set(due: Date): Promise<void>;
  /** Cancel the pending reminder. */
  cancel(): Promise<void>;
}

/** One message's reminder, live across row unmounts. */
export function useReminder(channelId: string, messageId: string, now: () => number = Date.now): UseReminder {
  useEffect(ensureLoaded, []);
  const key = keyOf(channelId, messageId);
  const due = useSyncExternalStore(
    marksStore.subscribe,
    () => marksStore.getState().dueByKey[key],
    () => marksStore.getState().dueByKey[key],
  );
  const dueAt = due !== undefined && Date.parse(due) > now() ? new Date(due) : null;

  const set = async (at: Date): Promise<void> => {
    const previous = marksStore.getState().dueByKey[key];
    setDue(key, at.toISOString());
    try {
      const mark = await api.setMark(REMINDER_KIND, channelId, messageId, at);
      if (mark?.due_at) setDue(key, mark.due_at);
    } catch (err) {
      setDue(key, previous);
      throw new Error(reminderError(err));
    }
  };

  const cancel = async (): Promise<void> => {
    const previous = marksStore.getState().dueByKey[key];
    setDue(key, undefined);
    try {
      await api.cancelMark(REMINDER_KIND, channelId, messageId);
    } catch (err) {
      // Already gone server-side (fired, or cancelled on another device):
      // that IS the state the member asked for.
      if (err instanceof ApiError && err.status === 404) return;
      setDue(key, previous);
      throw new Error(reminderError(err));
    }
  };

  return { dueAt, set, cancel };
}

/** Test seam: forget everything (module singletons otherwise persist). */
export function resetMarksForTests(): void {
  marksStore.setState({ status: 'idle', dueByKey: {} });
}

// ---------------------------------------------------------------------------
// Presets (KTD8): resolved to ABSOLUTE instants here, in the browser's own
// zone — the server stores and compares instants only, and the daylight-saving
// edge is the browser's to resolve.
// ---------------------------------------------------------------------------

export interface ReminderPreset {
  id: string;
  label: string;
  at: (now: Date) => Date;
}

function atNine(d: Date): Date {
  const out = new Date(d);
  out.setHours(9, 0, 0, 0);
  return out;
}

export const REMINDER_PRESETS: readonly ReminderPreset[] = [
  { id: '20m', label: 'In 20 minutes', at: (n) => new Date(n.getTime() + 20 * 60_000) },
  { id: '1h', label: 'In 1 hour', at: (n) => new Date(n.getTime() + 60 * 60_000) },
  { id: '3h', label: 'In 3 hours', at: (n) => new Date(n.getTime() + 3 * 60 * 60_000) },
  {
    id: 'tomorrow',
    label: 'Tomorrow at 9:00',
    at: (n) => {
      const d = new Date(n);
      d.setDate(d.getDate() + 1);
      return atNine(d);
    },
  },
  {
    id: 'next-week',
    label: 'Next Monday at 9:00',
    at: (n) => {
      const d = new Date(n);
      // Days until the NEXT Monday (a Monday goes a full week ahead).
      const delta = ((8 - d.getDay()) % 7) || 7;
      d.setDate(d.getDate() + delta);
      return atNine(d);
    },
  },
];

/** "Fri 3:00 PM" style — short, local. */
export function formatReminder(at: Date): string {
  return at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
}
