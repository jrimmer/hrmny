/**
 * @cytale/web — per-channel media overrides (calls V2 plan U8, R16/R17).
 *
 * The client half of the channel-override surface: the channel context
 * menu reads one view (`GET /channels/{id}/media-override`) — the
 * tri-state override row, the workspace master, and `overrides_allowed` —
 * and toggles through `putChannelMediaOverride` (@cytale/api-client),
 * tracked in this small vanilla-zustand store so every surface reading a
 * capability label stays in sync.
 *
 * VISIBILITY RULE (recorded per the unit brief): the override menu entries
 * render only when the view loads AND `overrides_allowed` is true. A 403
 * (plain member) or 404 (foreign/DM) marks the entry `denied` — hidden;
 * the server stays the enforcement point. A NETWORK failure marks it
 * `error` — the entries render DISABLED with the inline alert (the
 * visible-disabled posture; never silently gone while the answer is
 * unknown-but-recoverable).
 *
 * Optimistic with rollback (the notificationMute pattern): the label
 * flips immediately, `status` marks the PUT in flight, a failure reverts
 * the row + exposes `status: 'error'` for the menu's inline alert.
 */

import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';

import { api } from '../auth/session.js';
import type { ChannelMediaOverride } from '@cytale/api-client';

export type MediaOverrideStatus = 'idle' | 'loading' | 'ready' | 'denied' | 'error';

export interface MediaOverrideEntry {
  /** The channel's tri-state override (null = inherit master). */
  override: ChannelMediaOverride;
  /** The workspace's master capability values (labels render inheritance). */
  master: { calls: boolean; video: boolean; screenshare: boolean };
  /** The workspace's overrides_allowed flag (the visibility rule). */
  overridesAllowed: boolean;
  status: MediaOverrideStatus;
}

interface MediaOverrideState {
  byChannel: Record<string, MediaOverrideEntry>;
}

const DEFAULT_ENTRY: MediaOverrideEntry = {
  override: { calls: null, video: null, screenshare: null },
  master: { calls: true, video: true, screenshare: true },
  overridesAllowed: false,
  status: 'idle',
};

/** Module-default store (the SPA has exactly one override map). */
export const mediaOverrideStore = createStore<MediaOverrideState>()((_) => ({
  byChannel: {},
}));

/** Synchronous read. */
export function getMediaOverride(channelId: string): MediaOverrideEntry {
  return mediaOverrideStore.getState().byChannel[channelId] ?? DEFAULT_ENTRY;
}

/** Reactive read for surfaces (the context menu). */
export function useMediaOverride(channelId: string): MediaOverrideEntry {
  return useSyncExternalStore(
    mediaOverrideStore.subscribe,
    () => mediaOverrideStore.getState().byChannel[channelId] ?? DEFAULT_ENTRY,
    () => DEFAULT_ENTRY,
  );
}

function putEntry(channelId: string, patch: Partial<MediaOverrideEntry>): void {
  mediaOverrideStore.setState((s) => ({
    byChannel: {
      ...s.byChannel,
      [channelId]: { ...getMediaOverride(channelId), ...patch },
    },
  }));
}

/**
 * Fetch the channel's override view once per channel (idempotent — a
 * re-invocation while loading or ready is a no-op; the menu calls it on
 * every open, cheaply). 403/404 → `denied` (entries hidden); any other
 * failure → `error` (entries visible-disabled + the inline alert).
 */
export async function ensureMediaOverride(channelId: string): Promise<void> {
  const current = getMediaOverride(channelId);
  if (current.status !== 'idle') return;

  putEntry(channelId, { status: 'loading' });

  try {
    const view = await api.getChannelMediaOverride(channelId);
    putEntry(channelId, {
      override: view.override,
      master: {
        calls: view.master.calls,
        video: view.master.video,
        screenshare: view.master.screenshare,
      },
      overridesAllowed: view.overrides_allowed,
      status: 'ready',
    });
  } catch (err) {
    putEntry(channelId, { status: isDenied(err) ? 'denied' : 'error' });
  }
}

/** A 403 (plain member) or 404 (foreign/DM channel): not our surface. */
function isDenied(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 403 || status === 404;
}

/**
 * Toggle one capability for the channel: inherit (null) → the EXPLICIT
 * opposite of the current effective value; an explicit value → flipped.
 * Optimistic flip → PUT (full tri-state map) → keep or revert. Never
 * throws (the entry's `status` carries the outcome).
 */
export async function toggleMediaOverride(
  channelId: string,
  capability: 'calls' | 'video' | 'screenshare',
): Promise<void> {
  const current = getMediaOverride(channelId);
  const next = flip(current.override[capability], effectiveValues(current)[capability]);

  putEntry(channelId, {
    override: { ...current.override, [capability]: next },
    status: 'ready',
  });

  try {
    const view = await api.putChannelMediaOverride(channelId, {
      calls: current.override.calls,
      video: current.override.video,
      screenshare: current.override.screenshare,
      [capability]: next,
    } as ChannelMediaOverride);
    // The server echo is authoritative.
    putEntry(channelId, {
      override: view.override,
      overridesAllowed: view.overrides_allowed,
      status: 'ready',
    });
  } catch {
    putEntry(channelId, { override: current.override, status: 'error' });
  }
}

/** The channel's EFFECTIVE values (override-then-master) for labels. */
export function effectiveValues(entry: MediaOverrideEntry): {
  calls: boolean;
  video: boolean;
  screenshare: boolean;
} {
  const resolve = (v: boolean | null, m: boolean): boolean => (v == null ? m : v);
  return {
    calls: resolve(entry.override.calls, entry.master.calls),
    video: resolve(entry.override.video, entry.master.video),
    screenshare: resolve(entry.override.screenshare, entry.master.screenshare),
  };
}

/**
 * Reset every capability to inherit (the full-null PUT). Optimistic with
 * rollback, same as the single toggle.
 */
export async function resetMediaOverride(channelId: string): Promise<void> {
  const current = getMediaOverride(channelId);
  const cleared: ChannelMediaOverride = { calls: null, video: null, screenshare: null };

  putEntry(channelId, { override: cleared, status: 'ready' });

  try {
    const view = await api.putChannelMediaOverride(channelId, cleared);
    putEntry(channelId, {
      override: view.override,
      overridesAllowed: view.overrides_allowed,
      status: 'ready',
    });
  } catch {
    putEntry(channelId, { override: current.override, status: 'error' });
  }
}

function flip(current: boolean | null, effective: boolean): boolean {
  // inherit → the explicit opposite of what's in effect; explicit → flip.
  return current == null ? !effective : !current;
}

/** Test seam: reset the map + statuses between cases. */
export function resetMediaOverrideStoreForTests(): void {
  mediaOverrideStore.setState({ byChannel: {} });
}
