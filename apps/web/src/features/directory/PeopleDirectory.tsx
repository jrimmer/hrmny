/**
 * @cytale/web — People Directory (U26).
 *
 * Searchable workspace member list with presence, cursor pagination, and the
 * states-first DoD: loading / empty / error(retry) / offline / permission-denied.
 * Reads the U9 people REST contract via `fetchPeoplePage` (mocked in tests)
 * and joins presence from the U17 store seam (`useDirectoryMembers`).
 *
 * Keyboard navigation: the search input is the focus entry point; the results
 * list is a `role="listbox"` with arrow-key focusable options (roving
 * tabindex), so the directory is fully operable without a pointer.
 */

import { useEffect, useRef, useState } from 'react';

import { Avatar, kindTitle } from '../../app/ui/UserAvatar.js';
import { loadMoreButtonClass } from '../../app/ui/button.js';
import { StateBanner } from '../../app/ui/StateBanner.js';
import { useOnlineStatus } from '../../app/pwa/useOnlineStatus.js';

import { fetchPeoplePage, type PeopleApiError } from './api.js';
import type { PeopleMember, PresenceByUser } from './types.js';
import { useDirectoryMembers, type DirectoryStore } from './useDirectoryMembers.js';
import { PaneEmpty, PaneRetryButton } from '../../app/ui/PaneStates.js';
import { displayNameOf } from '@cytale/domain';

export interface PeopleDirectoryProps {
  workspaceId: string;
  /** Bearer token for the authenticated endpoint (U19 authStore seam). */
  token?: string;
  /** U17 store projection; null while bootstrapping. */
  store?: DirectoryStore | null;
  /** Presence override (U23 live source); defaults to store presence. */
  presence?: PresenceByUser;
  /** Debounce delay for the search query (ms). */
  debounceMs?: number;
  /**
   * Controlled search text — owned by the rail header's ⌕ toggle (the
   * directory's own input is gone). Server-side search is debounced here.
   */
  query?: string;
  /** Page size for cursor pagination. */
  pageSize?: number;
  /** Called when a member is selected (profile card / DM action seam). */
  onSelectMember?: (member: PeopleMember) => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

const DEFAULT_DEBOUNCE_MS = 250;

export function PeopleDirectory({
  workspaceId,
  token,
  store = null,
  presence: presenceOverride,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  pageSize = 50,
  query = '',
  onSelectMember,
}: PeopleDirectoryProps) {
  const online = useOnlineStatus();

  const { presence: storePresence } = useDirectoryMembers(store, workspaceId);

  // Presence: explicit override wins, else store presence, else offline.
  const presence: PresenceByUser = presenceOverride ?? storePresence;

  // Search is owned by the rail header (the ⌕ toggle): the directory is
  // fully controlled — `query` is the rail's live search text.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [rows, setRows] = useState<PeopleMember[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Debounce the query.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), debounceMs);
    return () => clearTimeout(t);
  }, [query, debounceMs]);

  // Load the first page whenever the debounced query, workspace, or a retry
  // (reloadNonce bump) changes.
  useEffect(() => {
    let cancelled = false;
    setLoadState({ kind: 'loading' });
    setPermissionDenied(false);

    fetchPeoplePage({ workspaceId, query: debouncedQuery, limit: pageSize, token })
      .then((page) => {
        if (cancelled) return;
        setRows(page.people);
        setNextBefore(page.next_before);
        setLoadState({ kind: 'ready' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const apiErr = err as PeopleApiError;
        if (apiErr.status === 403) {
          setPermissionDenied(true);
          setLoadState({ kind: 'ready' });
        } else {
          setLoadState({ kind: 'error', message: apiErr.message ?? 'Failed to load members.' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, debouncedQuery, pageSize, token, reloadNonce]);

  const loadMore = () => {
    if (!nextBefore || loadState.kind !== 'ready') return;
    setLoadState({ kind: 'loading' });

    fetchPeoplePage({ workspaceId, query: debouncedQuery, before: nextBefore, limit: pageSize, token })
      .then((page) => {
        // A live join may already have appended someone this page carries.
        setRows((prev) => {
          const have = new Set(prev.map((r) => r.user.id));
          return [...prev, ...page.people.filter((p) => !have.has(p.user.id))];
        });
        setNextBefore(page.next_before);
        setLoadState({ kind: 'ready' });
      })
      .catch((err: unknown) => {
        const apiErr = err as PeopleApiError;
        setLoadState({ kind: 'error', message: apiErr.message ?? 'Failed to load more members.' });
      });
  };

  const retry = () => setReloadNonce((n) => n + 1);

  // LIVE roster (2026-10-02): the list is a REST read, but membership and
  // names change under it — a deleted bot, a kick, a revoked grant
  // (MemberRemove), a join or a grant (MemberAdd), a rename (UserUpdate).
  // The store applies those events; the directory follows the store's
  // membership DIFF for this workspace (an id leaving the list leaves the
  // directory; an id joining it is appended), and draws names and avatars
  // from the store's row, which a live UserUpdate keeps current.
  const liveIds = store?.memberIdsByWorkspace[workspaceId];
  const previousIds = useRef<{ workspaceId: string; ids: readonly string[] | undefined }>({
    workspaceId,
    ids: liveIds,
  });
  useEffect(() => {
    const prev = previousIds.current;
    previousIds.current = { workspaceId, ids: liveIds };
    if (prev.workspaceId !== workspaceId || prev.ids === undefined || liveIds === undefined) return;
    const next = new Set(liveIds);
    const before = new Set(prev.ids);
    const removed = new Set(prev.ids.filter((id) => !next.has(id)));
    const added = liveIds.filter((id) => !before.has(id));
    if (removed.size === 0 && added.length === 0) return;
    setRows((current) => {
      let out = removed.size > 0 ? current.filter((r) => !removed.has(r.user.id)) : current;
      if (added.length > 0 && debouncedQuery === '') {
        const have = new Set(out.map((r) => r.user.id));
        const joined: PeopleMember[] = [];
        for (const id of added) {
          const m = store?.membersById[id];
          if (!m || have.has(id)) continue;
          joined.push({
            user: { id: m.id, username: m.username, display_name: m.display_name ?? null, avatar_url: m.avatar_url ?? null },
            nickname: store?.nicknamesByWorkspace?.[workspaceId]?.[id] ?? null,
            joined_at: null,
            roles: [],
            kind: m.kind,
            parent_user_id: m.parent_user_id,
          });
        }
        if (joined.length > 0) out = [...out, ...joined];
      }
      return out;
    });
  }, [workspaceId, liveIds, store, debouncedQuery]);

  // A row as the store knows it NOW: the handle, display name (#168) and
  // avatar from the shared row, and the nickname from THIS workspace's map
  // (#169) — live through MemberUpdate. Before the map knows the workspace,
  // the page's own nickname stands.
  const shown = (m: PeopleMember): PeopleMember => {
    const live = store?.membersById[m.user.id];
    if (!live) return m;
    const nicks = store?.nicknamesByWorkspace?.[workspaceId];
    const nickname = nicks !== undefined ? (nicks[m.user.id] ?? null) : m.nickname;
    return {
      ...m,
      user: {
        ...m.user,
        username: live.username,
        display_name: live.display_name !== undefined ? live.display_name : (m.user.display_name ?? null),
        avatar_url: live.avatar_url ?? m.user.avatar_url ?? null,
      },
      nickname,
    };
  };

  // Keyboard navigation over the results list (roving tabindex).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((i) => (i + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((i) => (i <= 0 ? rows.length - 1 : i - 1));
    } else if (e.key === 'Enter' && focusedIndex >= 0) {
      e.preventDefault();
      const member = rows[focusedIndex];
      if (member) onSelectMember?.(member);
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${focusedIndex}"]`);
    el?.focus();
  }, [focusedIndex]);

  const displayName = (m: PeopleMember) => displayNameOf({ ...m.user, nickname: m.nickname });

  // U12 attribution: machine principals are synthesized beside their parent
  // in people reads, so the parent's display name resolves from the loaded
  // rows first, then the store seam. Unresolvable → badge without "via".
  const parentNameOf = (m: PeopleMember): string | undefined => {
    if (!m.parent_user_id) return undefined;
    const row = rows.find((r) => r.user.id === m.parent_user_id);
    if (row) return displayNameOf({ ...row.user, nickname: row.nickname });
    const sm = store?.membersById[m.parent_user_id];
    return displayNameOf(sm) || undefined;
  };

  return (
    <div className="people-directory" data-testid="people-directory">
      {!online ? (
        <StateBanner tone="warning" testId="people-offline">
          You are offline — member list may be stale.
        </StateBanner>
      ) : null}

      {permissionDenied ? (
        <StateBanner tone="danger" testId="people-permission-denied">
          You don't have permission to view this workspace's members.
        </StateBanner>
      ) : loadState.kind === 'loading' ? (
        <div
          role="progressbar"
          aria-busy="true"
          aria-label="Loading members"
          data-testid="people-loading"
          className="flex flex-col gap-2"
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2" aria-hidden="true">
              <div className="h-9 w-9 animate-pulse motion-reduce:animate-none rounded-full bg-surface-hover" />
              <div className="flex-1">
                <div className="h-3.5 w-28 animate-pulse motion-reduce:animate-none rounded bg-surface-hover" />
                <div className="mt-1.5 h-2.5 w-20 animate-pulse motion-reduce:animate-none rounded bg-surface-hover" />
              </div>
            </div>
          ))}
          <span className="sr-only">Loading members…</span>
        </div>
      ) : loadState.kind === 'error' ? (
        <StateBanner
          tone="danger"
          testId="people-error"
          action={
            <PaneRetryButton testId="people-retry" onRetry={retry} />
          }
        >
          {loadState.message}
        </StateBanner>
      ) : rows.length === 0 ? (
        <PaneEmpty testId="people-empty" title="No members found." hint="Try a different name or handle." />
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Members"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          data-testid="people-list"
        >
          {rows.map(shown).map((m, i) => {
            const status = presence[m.user.id] ?? 'offline';
            return (
              <li
                key={m.user.id}
                role="option"
                tabIndex={focusedIndex === i ? 0 : -1}
                data-index={i}
                data-testid={`people-row-${m.user.id}`}
                className="flex cursor-pointer items-center gap-3 rounded-md px-4 py-1.5 transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] aria-selected:bg-surface-hover"
                aria-selected={focusedIndex === i ? 'true' : undefined}
                // Pointer highlight is the `hover:` style above, which is live:
                // it needs no state and disappears when the pointer leaves.
                // This used to write `focusedIndex` on mouseenter, which both
                // marked the row `aria-selected` and moved DOM focus to it, so
                // the last-hovered row stayed highlighted with the pointer
                // elsewhere (user report 2026-09-11: "only highlight when
                // there's an active mouseover").
                onClick={() => onSelectMember?.(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectMember?.(m);
                  }
                }}
              >
                <Avatar
                  id={m.user.id}
                  name={displayName(m)}
                  src={m.user.avatar_url}
                  className="people-avatar"
                  data-presence={status}
                  kind={m.kind}
                  parentName={parentNameOf(m)}
                />
              <span className="people-identity">
                <span className="people-name">{displayName(m)}</span>
                <span className="people-handle">@{m.user.username}</span>
              </span>
              {/* The seal is decorative; the attribution it stands for is
                  announced here (machine principals only). */}
              {kindTitle(m.kind, parentNameOf(m)) ? (
                <span className="sr-only">{kindTitle(m.kind, parentNameOf(m))}</span>
              ) : null}
              {/* Presence renders on the avatar (bottom-right dot, panel
                  parity); the word stays for screen readers. */}
              <span className="sr-only">{status}</span>
              </li>
            );
          })}
        </ul>
      )}

      {loadState.kind === 'ready' && nextBefore ? (
        <button
          type="button"
          onClick={loadMore}
          data-testid="people-load-more"
          className={loadMoreButtonClass}
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}
