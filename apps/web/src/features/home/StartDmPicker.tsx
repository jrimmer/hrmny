/**
 * @cytale/web — the "Start conversation" member picker (#94).
 *
 * The DM column's creation affordance: a centred Radix modal (Discord's
 * New Message sheet, minus the Friends concept — Cytale has no friend
 * graph) that type-to-filters the members you share a workspace with and
 * opens the DM on selection. The candidate pool is the workspace ROSTERS
 * the store hydrated (`memberIdsByWorkspace` × `membersById`), grouped by
 * the workspace you share — never an instance-wide directory (#94 scope
 * guard).
 *
 * Keyboard-complete like the PeopleDirectory listbox it mirrors: the To
 * input is the focus entry point; ArrowUp/Down move the roving selection,
 * Enter opens, Escape closes (Radix). States-first: a filter miss has its
 * own empty copy, an in-flight open is announced, and a refused open (403
 * unverified / forbidden, bot-to-bot 400) keeps the dialog open with the
 * server's message and the selection retained for a retry.
 */
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';

import type { Channel, PrincipalKind } from '@cytale/domain';

import { Avatar } from '../../app/ui/UserAvatar.js';

import { dialogErrorMessage } from '../channels/dialogError.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';
import { displayNameOf } from '@cytale/domain';

/** One picker row: the member fields the roster hydration carries. */
export interface DmCandidate {
  id: string;
  username: string;
  avatar_url?: string | null;
  nickname?: string | null;
  /** The account's display name (#168). */
  display_name?: string | null;
  /** Principal kind — 'human' for people, a machine kind for agents. */
  kind?: PrincipalKind | null;
  /** A machine principal's owning human, for the seal's tooltip. */
  parentName?: string | null;
  /** The agent's DM-support policy: who it will hold a conversation with. */
  dmSupport?: 'humans' | 'everyone' | 'none' | null;
}

/**
 * Who the app will actually open a conversation with. The server's rule is the
 * agent's own DM-support policy (`humans` by default, `everyone`, or `none`)
 * plus the webhook refusal, and the roster now publishes that policy as
 * `dm_support`, so the picker marks a row it cannot open instead of letting the
 * attempt fail after the fact (owner report 2026-09-15: "that should've been
 * indicated on the DM user search list so that no DM is even opened or
 * attempted"). An unknown value stays allowed — the server is the authority
 * there, and its refusal renders in this dialog.
 */
function dmable(candidate: DmCandidate): boolean {
  // A person is always a candidate. An AGENT is one unless its owner set the
  // policy to :none — `humans` (the default) and `everyone` both accept people
  // (owner direction 2026-09-15: "DM support: with humans, with everyone,
  // none; default with humans"). An unknown value reads as the default rather
  // than guessing a refusal, and the server stays the authority either way.
  return candidate.kind == null || candidate.kind === 'human' || candidate.dmSupport !== 'none';
}

/** Why a row cannot be messaged, in the reader's words. */
function dmBlockedReason(candidate: DmCandidate): string {
  return candidate.kind === 'webhook'
    ? "Webhooks can't be messaged directly."
    : "This agent doesn't accept direct messages.";
}

/**
 * One entry per PERSON, already deduped by the host. Not grouped by workspace:
 * a DM is instance-wide (the roster endpoint carries no workspace), so the same
 * human is one target however many workspaces you share — grouping them listed
 * the same person under each workspace's label (user report 2026-09-14).
 */
export interface StartDmPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: DmCandidate[];
  /**
   * Opens (or returns the existing) DM with the member. Resolves with the
   * channel so the caller can navigate; rejects with the server's error,
   * which this dialog surfaces inline without losing the selection.
   */
  onStartDm: (memberId: string) => Promise<Channel>;
}

/** Case-insensitive match over display name + handle (type-to-filter). */
function matches(candidate: DmCandidate, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  // Every name the person is shown or known by (#168).
  return [candidate.nickname, candidate.display_name, candidate.username].some(
    (name) => typeof name === 'string' && name.toLowerCase().includes(q),
  );
}

export function StartDmPicker({ open, onOpenChange, candidates, onStartDm }: StartDmPickerProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fresh picker every time it opens (the CreateWorkspaceDialog contract).
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setPendingId(null);
      setError(null);
    }
  }, [open]);

  // The visible rows, in the host's order, for both rendering and the roving
  // index — one list, so the index can never drift from what is drawn.
  const flat = useMemo(
    () => candidates.filter((m) => matches(m, query)),
    [candidates, query],
  );

  const select = async (candidate: DmCandidate) => {
    if (pendingId) return; // one open in flight — a second Enter is a no-op
    // Belt and braces with the row's own guard: no request leaves the client
    // for a principal the server will refuse, so nothing is "attempted".
    if (!dmable(candidate)) return;
    setError(null);
    setPendingId(candidate.id);
    try {
      await onStartDm(candidate.id);
      onOpenChange(false);
    } catch (err) {
      setError(
        dialogErrorMessage(
          err,
          "You can't start this conversation yet.",
          'Could not open the conversation. Try again.',
        ),
      );
      // Retain the selection: the failed member stays the active row.
      setActiveIndex(Math.max(flat.findIndex((m) => m.id === candidate.id), 0));
    } finally {
      setPendingId(null);
    }
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const candidate = flat[activeIndex];
      if (candidate) void select(candidate);
    }
    // Escape needs no handling — Radix closes the dialog.
  };

  const pending = pendingId !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o);
      }}
    >
      {/* showCloseButton={false}: the house ✕ below keeps its own styling
          and pending-disable; the wrapper's default close would duplicate. */}
      <DialogContent
        className="modal-panel dm-picker-panel"
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="dm-picker"
        aria-busy={pending || undefined}
      >
          <DialogTitle className="modal-title">Start a conversation</DialogTitle>
          <DialogClose className="modal-close" aria-label="Close" disabled={pending}>
            ✕
          </DialogClose>
          <p className="modal-explainer">Pick someone you share a workspace with.</p>

          <label className="modal-label" htmlFor="dm-picker-input">
            To
          </label>
          <input
            id="dm-picker-input"
            data-testid="dm-picker-input"
            className="modal-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Name or username"
            autoComplete="off"
            autoFocus
          />

          {error ? (
            <p role="alert" data-testid="dm-picker-error" className="modal-error">
              {error}
            </p>
          ) : null}

          {flat.length === 0 ? (
            <p className="home-empty" data-testid="dm-picker-empty">
              {candidates.length === 0
                ? 'No members yet — join a workspace to find people.'
                : 'No members match.'}
            </p>
          ) : (
            <ul
              className="dm-picker-list"
              role="listbox"
              aria-label="Members"
              aria-busy={pending || undefined}
              data-testid="dm-picker-results"
            >
              {flat.map((member, index) => {
                const isActive = index === activeIndex;
                const isPending = member.id === pendingId;
                const blocked = !dmable(member);
                const displayName = displayNameOf(member);
                return (
                  <li
                    key={member.id}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={pending || blocked || undefined}
                    tabIndex={-1}
                    className="dm-picker-option"
                    data-testid={`dm-picker-result-${member.id}`}
                    data-active={isActive || undefined}
                    data-blocked={blocked || undefined}
                    onClick={() => {
                      if (!pending && !blocked) void select(member);
                    }}
                  >
                    <Avatar
                      id={member.id}
                      name={displayName}
                      src={member.avatar_url}
                      className="people-avatar"
                      kind={member.kind ?? null}
                      parentName={member.parentName ?? null}
                    />
                    <span className="people-identity">
                      <span className="people-name">{displayName}</span>
                      {/* A machine principal says why it is unmessagable IN
                          PLACE OF its handle: the reason is the useful line,
                          and it stays visible rather than appearing only after
                          a failed attempt. */}
                      {blocked ? (
                        <span
                          className="people-handle"
                          data-testid={`dm-picker-blocked-${member.id}`}
                        >
                          {dmBlockedReason(member)}
                        </span>
                      ) : (
                        <span className="people-handle">@{member.username}</span>
                      )}
                    </span>
                    {isPending ? (
                      <span className="people-handle" data-testid="dm-picker-pending">
                        Opening…
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
      </DialogContent>
    </Dialog>
  );
}
