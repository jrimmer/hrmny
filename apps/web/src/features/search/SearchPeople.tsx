/**
 * @cytale/web — people directory search (U24).
 *
 * A separate tab/section for searching workspace members by name/handle
 * (R14). Reuses the U26 people-directory fetch contract
 * (`GET /api/v1/workspaces/:id/people?query=`). Clicking a member navigates
 * to their profile or opens a DM (the parent wires the action).
 */

import { useEffect, useState } from 'react';

import { fetchPeoplePage } from '../directory/api.js';
import type { PeopleMember, PeoplePage } from '../directory/types.js';
import { displayNameOf } from '@cytale/domain';

export interface SearchPeopleProps {
  workspaceId: string;
  /** Bearer token for the authenticated endpoint (U19 authStore seam). */
  token?: string;
  /** Debounce delay in ms (tests override). */
  debounceMs?: number;
  /** Called when a member is selected (profile / DM). */
  onSelectMember?: (member: PeopleMember) => void;
  /** Test hook for the input. */
  inputTestId?: string;
}

type PeopleStatus = 'idle' | 'loading' | 'error' | 'empty' | 'results';

export function SearchPeople({
  workspaceId,
  token,
  debounceMs = 300,
  onSelectMember,
  inputTestId = 'search-people-input',
}: SearchPeopleProps) {
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<PeopleStatus>('idle');
  const [members, setMembers] = useState<PeopleMember[]>([]);

  useEffect(() => {
    if (input.trim() === '') {
      setStatus('idle');
      setMembers([]);
      return;
    }

    const timer = setTimeout(async () => {
      setStatus('loading');
      try {
        const page: PeoplePage = await fetchPeoplePage({
          workspaceId,
          query: input.trim(),
          token,
        });
        setMembers(page.people);
        setStatus(page.people.length > 0 ? 'results' : 'empty');
      } catch {
        setStatus('error');
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [input, debounceMs, workspaceId, token]);

  return (
    <div data-testid="search-people" className="px-2 py-2">
      <input
        type="text"
        role="searchbox"
        aria-label="Search people"
        data-testid={inputTestId}
        value={input}
        placeholder="Search people…"
        onChange={(e) => setInput(e.target.value)}
        className="w-full rounded-md border border-input-line bg-input px-3 py-1.5 text-sm text-text transition-colors duration-[var(--duration-control)] placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--color-focus)]"
      />

      {status === 'loading' && (
        <div role="status" data-testid="search-people-loading" className="mt-2 text-sm text-text-muted">
          Searching…
        </div>
      )}
      {status === 'error' && (
        <div role="alert" data-testid="search-people-error" className="mt-2 text-sm text-text-muted">
          Could not search people.
        </div>
      )}
      {status === 'empty' && (
        <div data-testid="search-people-empty" className="mt-2 text-sm text-text-muted">
          No people found.
        </div>
      )}
      {status === 'results' && (
        <ul data-testid="search-people-results" className="mt-2 divide-y divide-border">
          {members.map((m) => (
            <li key={m.user.id}>
              <button
                type="button"
                data-testid={`search-people-result-${m.user.id}`}
                onClick={() => onSelectMember?.(m)}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              >
                <span className="block font-medium text-text-primary">{displayNameOf({ ...m.user, nickname: m.nickname })}</span>
                <span className="block text-xs text-text-muted">@{m.user.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
