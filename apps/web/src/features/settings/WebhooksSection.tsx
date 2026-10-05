/**
 * @cytale/web — WebhooksSection: the incoming URLs YOU own, and where each one
 * posts (plan 2026-09-15-1200, U3).
 *
 * The one management surface for a webhook (KD1). It replaces the rail's
 * channel-scoped pane, and the change in scope is the point: a webhook belongs
 * to the person who created it (KD2), so this lists across every workspace and
 * keeps working when its creator loses `manage_channels` on the destination —
 * which is the only stop a webhook's URL has, since the token is exempt from
 * every downstream rights check by design.
 *
 * `GET /users/@me/webhooks` is also the one read that carries the capability
 * URL: the caller is the one who can already post with it. The channel-scoped
 * governance read is the other half (a destination's managers see what posts
 * into their channel, without the token) and is not this surface.
 *
 * The row treatment, the copy affordance and the inline rename/confirm moved
 * here from the pane rather than being rewritten; the data model did change
 * (one owner-scoped read instead of a fan-out over the workspace's channels),
 * which is why the loading and permission states are simpler — there is no
 * partial denial to aggregate, because there is no second request to fail.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@cytale/api-client';

import { StateBanner } from '../../app/ui/StateBanner.js';
import { primaryButtonClass } from '../../app/ui/button.js';

import * as settingsApi from './api.js';
import type { MyWebhook } from './api.js';
import { copyToClipboard } from './clipboard.js';
import { InlineConfirm } from './InlineConfirm.js';
import { PaneEmpty, PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import type { ChannelOption, TreeWorkspace } from './types.js';
import { usePaneList } from './usePaneList.js';

export interface WebhooksSectionProps {
  /** The caller's workspaces — the create form's first step. */
  workspaces: TreeWorkspace[];
  /** Preselected workspace (the one the shell has open). */
  activeWorkspaceId?: string | null;
  /**
   * The selected workspace's channels as the SHELL already knows them
   * (hydrated workspaces only, so it may be empty). A change here re-derives
   * the room options, which is how a channel created elsewhere shows up
   * without remounting the section.
   */
  channels?: ChannelOption[];
  /** Channels of a workspace the client has not hydrated, fetched on demand. */
  loadChannels(workspaceId: string): Promise<ChannelOption[]>;
  online: boolean;
}

function CopyUrlButton({ url, testId }: { url: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      aria-live="polite"
      onClick={async () => {
        if (await copyToClipboard(url)) setCopied(true);
      }}
      className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
    >
      {copied ? 'Copied!' : 'Copy URL'}
    </button>
  );
}

/** `#channel · Workspace`, or what is left of it when a name is missing. */
export function describeDestination(row: MyWebhook): string {
  const destination = row.destination;
  if (destination === null) return 'Destination unavailable';
  const channel = destination.channel_name ? `#${destination.channel_name}` : 'this channel';
  return destination.workspace_name ? `${channel} · ${destination.workspace_name}` : channel;
}

export function WebhooksSection({
  workspaces,
  activeWorkspaceId = null,
  channels: hydrated,
  loadChannels,
  online,
}: WebhooksSectionProps) {
  // Create form. A webhook belongs to a CHANNEL, and a channel belongs to a
  // workspace, so the picker walks that path: workspace → room. The shell's
  // open workspace is preselected; every other one loads its channels on demand.
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? '');
  const [loaded, setLoaded] = useState<ChannelOption[]>([]);
  const [channelsState, setChannelsState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [channelId, setChannelId] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Inline rename (one row at a time).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const hydratedRooms = hydrated ?? [];
  /** What the picker offers: the shell's roster if it has one, else the fetch. */
  const rooms = hydratedRooms.length > 0 ? hydratedRooms : loaded;

  // ONE owner-scoped read — no fan-out, so no partial-denial aggregation. A
  // 403 here is the account-level refusal (unverified), which `usePaneList`
  // maps to the permission-denied treatment.
  const listRows = useCallback(async (): Promise<MyWebhook[]> => {
    const rows = await settingsApi.listMyWebhooks();
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const {
    items: rows,
    loadState,
    permissionDenied,
    reload,
    setError,
  } = usePaneList(listRows, { errorFallback: 'Could not load your webhooks.' });

  // The hydrated roster's identity as a plain string: the effect re-runs when
  // the shell learns about a new room, and must NOT re-run on every render
  // just because a caller passed a fresh array.
  const hydratedKey = hydratedRooms.map((c) => c.id).join(',');

  // The loader is read through a ref so the effect depends ONLY on the picked
  // workspace: a caller passing an inline arrow (every render is a new
  // function) must not re-fetch the room list on each render.
  const loadChannelsRef = useRef(loadChannels);
  useEffect(() => {
    loadChannelsRef.current = loadChannels;
  }, [loadChannels]);

  // Load the picked workspace's rooms. The selection resets because a channel
  // id from another workspace is not a valid webhook target.
  useEffect(() => {
    setChannelId('');
    // The shell's roster is authoritative when it has one for this workspace.
    if (workspaceId === '' || (workspaceId === activeWorkspaceId && hydratedRooms.length > 0)) {
      setLoaded([]);
      setChannelsState(hydratedRooms.length > 0 ? 'ready' : 'idle');
      if (hydratedRooms.length > 0 && channelId === '') setChannelId(hydratedRooms[0]!.id);
      return;
    }

    let cancelled = false;
    setChannelsState('loading');
    setLoaded([]);

    void loadChannelsRef
      .current(workspaceId)
      .then((next) => {
        if (cancelled) return;
        setLoaded(next);
        setChannelsState('ready');
        if (next.length > 0) setChannelId(next[0]!.id);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded([]);
        setChannelsState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, hydratedKey]);

  const create = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (channelId === '') {
      setCreateError('Pick a workspace and a room for the webhook.');
      return;
    }
    if (trimmed === '') {
      setCreateError('Give the webhook a name.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await settingsApi.createWebhook(channelId, { name: trimmed });
      setName('');
      reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the webhook.');
    } finally {
      setCreating(false);
    }
  };

  const startRename = (row: MyWebhook) => {
    setRenamingId(row.id);
    setRenameValue(row.name);
    setRenameError(null);
  };

  const saveRename = async () => {
    if (renamingId == null) return;
    const trimmed = renameValue.trim();
    if (trimmed === '') {
      setRenameError('Name cannot be empty.');
      return;
    }
    try {
      await settingsApi.updateMyWebhook(renamingId, { name: trimmed });
      setRenamingId(null);
      reload();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Could not rename the webhook.');
    }
  };

  const remove = async (row: MyWebhook) => {
    try {
      await settingsApi.deleteMyWebhook(row.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the webhook.');
    }
  };

  return (
    <div data-testid="webhooks-section" className="flex flex-col gap-4">
      {!online ? (
        <StateBanner tone="warning" testId="webhooks-offline">
          You are offline — creating and destructive actions are disabled until the connection
          returns.
        </StateBanner>
      ) : null}

      {permissionDenied != null ? (
        <StateBanner tone="danger" testId="webhooks-permission-denied">
          Your account is not verified yet, so webhooks are unavailable. Verify your email and
          reload.
        </StateBanner>
      ) : loadState.kind === 'loading' ? (
        <PaneSkeleton label="Loading webhooks" testId="webhooks-loading" />
      ) : loadState.kind === 'error' ? (
        <PaneErrorBanner
          testId="webhooks-error"
          retryTestId="webhooks-retry"
          message={loadState.message}
          onRetry={reload}
        />
      ) : (
        <>
          <section
            aria-label="Create a webhook"
            className="rounded-md border border-line bg-surface p-4"
          >
            <h3 className="text-sm font-semibold text-text-primary">Create a webhook</h3>
            <p className="mt-1 text-xs text-text-muted">
              It posts into the room you pick. Creating one needs permission to manage that
              channel.
            </p>
            <div className="mt-2 flex flex-wrap items-start gap-2">
              <div className="flex w-44 flex-col gap-1">
                <label htmlFor="webhook-workspace" className="sr-only">
                  Workspace
                </label>
                <select
                  id="webhook-workspace"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  data-testid="webhook-workspace-select"
                  className="min-h-10 rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                >
                  <option value="">Pick a workspace…</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex w-44 flex-col gap-1">
                <label htmlFor="webhook-channel" className="sr-only">
                  Room
                </label>
                <select
                  id="webhook-channel"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  disabled={workspaceId === '' || rooms.length === 0}
                  data-testid="webhook-channel-select"
                  className="min-h-10 rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {channelsState === 'loading' ? <option value="">Loading rooms…</option> : null}
                  {channelsState === 'error' ? <option value="">Could not load rooms</option> : null}
                  {channelsState !== 'loading' && rooms.length === 0 ? (
                    <option value="">No rooms</option>
                  ) : null}
                  {rooms.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex min-w-44 flex-1 flex-col gap-1">
                <label htmlFor="webhook-name" className="sr-only">
                  Name
                </label>
                <input
                  id="webhook-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name (e.g. Deploy bot)"
                  data-testid="webhook-name-input"
                  className="min-h-10 w-full rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                />
              </div>
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating || !online || rooms.length === 0}
                data-testid="webhook-create"
                className={
                  primaryButtonClass +
                  (creating || !online || rooms.length === 0 ? ' cursor-not-allowed opacity-50' : '')
                }
              >
                {creating ? 'Creating…' : 'Create webhook'}
              </button>
            </div>
            {createError ? (
              <p role="alert" className="mt-2 text-sm text-danger" data-testid="webhook-create-error">
                {createError}
              </p>
            ) : null}
          </section>

          <section aria-label="Your webhooks">
            <h3 className="sr-only">Your webhooks</h3>
            {rows.length === 0 ? (
              <PaneEmpty
                testId="webhooks-empty"
                title="No webhooks yet"
                hint="Create one for a channel — external services POST to its URL, and every one you make is listed here."
              />
            ) : (
              <ul className="flex flex-col gap-2" data-testid="webhooks-list">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    data-testid={`webhook-row-${row.id}`}
                    className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="min-w-40 flex-1">
                        <p className="text-sm font-medium text-text-primary">{row.name}</p>
                        <p className="text-xs text-text-muted" data-testid={`webhook-destination-${row.id}`}>
                          {describeDestination(row)}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <CopyUrlButton url={row.url} testId={`webhook-copy-url-${row.id}`} />
                        <button
                          type="button"
                          onClick={() => (renamingId === row.id ? setRenamingId(null) : startRename(row))}
                          data-testid={`webhook-rename-${row.id}`}
                          className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                        >
                          {renamingId === row.id ? 'Cancel rename' : 'Rename'}
                        </button>
                        <InlineConfirm
                          label="Revoke"
                          consequence="This stops deliveries immediately — the URL stops working."
                          confirmLabel="Revoke"
                          tone="danger"
                          disabled={!online}
                          disabledReason="Wait for the connection to return."
                          onConfirm={() => void remove(row)}
                          testId={`webhook-delete-${row.id}`}
                        />
                      </div>
                    </div>

                    <label className="sr-only" htmlFor={`webhook-url-${row.id}`}>
                      Webhook URL for {row.name}
                    </label>
                    <input
                      id={`webhook-url-${row.id}`}
                      readOnly
                      value={row.url}
                      data-testid={`webhook-url-${row.id}`}
                      onFocus={(e) => e.target.select()}
                      className="w-full rounded-md border border-line bg-surface-strong px-3 py-1.5 font-mono text-xs text-text"
                    />

                    {renamingId === row.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="sr-only" htmlFor={`webhook-rename-input-${row.id}`}>
                          New name for {row.name}
                        </label>
                        <input
                          id={`webhook-rename-input-${row.id}`}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          data-testid={`webhook-rename-input-${row.id}`}
                          className="min-h-10 flex-1 rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                        />
                        <button
                          type="button"
                          onClick={() => void saveRename()}
                          disabled={!online}
                          data-testid={`webhook-rename-save-${row.id}`}
                          className={primaryButtonClass + (!online ? ' cursor-not-allowed opacity-50' : '')}
                        >
                          Save
                        </button>
                        {renameError ? (
                          <p
                            role="alert"
                            className="text-sm text-danger"
                            data-testid={`webhook-rename-error-${row.id}`}
                          >
                            {renameError}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Re-exported so a caller can render the api's own refusal key without importing ApiError. */
export { ApiError };
