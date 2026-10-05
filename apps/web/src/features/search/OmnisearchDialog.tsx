/**
 * @cytale/web — the Cmd-K omnisearch palette.
 *
 * One query over the caller's reachable messages: workspace hits through the
 * server's visible-channel gate and DM hits from the caller's own per-user
 * index — permission is the server's job end to end, so the palette never
 * filters, it only renders what came back.
 *
 * Interaction shape (the consensus across Linear/Raycast/Slack/Discord
 * palettes, researched 2026-09-15): ⌘K/Ctrl-K opens (the listener lives in
 * the shell), the input is focused the moment it opens, results are GROUPED
 * (Messages, Direct Messages) with a roving keyboard selection that the mouse
 * can drive too, Enter jumps, Escape closes (Radix). Nothing is selected by
 * default in the hint state — arrows or hover pick the first row.
 *
 * Jumping rides the permalink the router already understands
 * (`#/workspace/…/message/…`, `#/channel/…/message/…` for DMs) — the same
 * address Copy Link and the inbox produce, so search results land on the
 * message with the pane's flash-and-scroll focus for free.
 */
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../../components/shadcn/command.js';
import { DialogClose } from '../../components/shadcn/dialog.js';
import { useEffect, useMemo, useState } from 'react';

import type { PrincipalKind } from '@cytale/domain';
import { defaultStore } from '@cytale/state';

import { PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { Avatar } from '../../app/ui/UserAvatar.js';
import { formatMessageStamp } from '../../app/ui/time.js';
import { channelNameOf } from '../messages/ChannelMentionPill.js';
import { MentionExcerpt } from '../messages/MentionExcerpt.js';
import { resolveAuthor } from '../messages/authorIdentity.js';
import { dmParticipants } from '../messages/dmRoster.js';
import { createMentionResolver } from '../messages/mentionResolver.js';
import { messagePermalinkUrl } from '../messages/messagePermalink.js';
import { fetchOmnisearch, type OmniHit } from './api.js';
import { displayNameOf } from '@cytale/domain';

/** Below this the server answers empty anyway; skip the request entirely. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

type Status = 'idle' | 'loading' | 'empty' | 'results' | 'error';

export interface OmnisearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bearer token (the authStore seam — the endpoint is authenticated). */
  token: string | null;
  /** Fixed clock for tests. */
  now?: number;
}

interface Row {
  hit: OmniHit;
  /** Where the message lives, in the reader's words: `#general` / `Max Power`. */
  where: string;
  who: string;
  /** The author's uploaded image, when the roster or the DM knows it. */
  avatarUrl: string | null;
  /** The author's principal kind (the machine seal) and a machine's owner. */
  kind: PrincipalKind | null;
  parentName: string | null;
}

export function OmnisearchDialog({ open, onOpenChange, token, now = Date.now() }: OmnisearchDialogProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [rows, setRows] = useState<Row[]>([]);
  /** Bumped by Retry: re-runs the search effect for the same query. */
  const [attempt, setAttempt] = useState(0);

  // Fresh palette every time it opens (the CreateWorkspaceDialog contract).
  useEffect(() => {
    if (open) {
      setQuery('');
      setStatus('idle');
      setRows([]);
    }
  }, [open]);

  // The debounced search itself. Every keystroke aborts the previous request
  // so a slow answer can never overwrite a newer query's results.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < MIN_QUERY) {
      setStatus(q.length === 0 ? 'idle' : 'idle');
      setRows([]);
      return;
    }

    setStatus('loading');
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchOmnisearch({ q, token: token ?? undefined, signal: controller.signal })
        .then((page) => {
          const store = defaultStore.getState();
          const selfId = store.currentUser?.id ?? null;
          const next = page.results.map((hit) => {
            const channel = store.channels[hit.channel_id];
            // The shared resolver (authorIdentity.ts): the roster (nickname,
            // then handle; bots badge like people), a DM's own participants,
            // the session self — the hit's mention pills use the same chain.
            const author = resolveAuthor(store.membersById, hit.author_id, {
              self: store.currentUser,
              nicknames: channel?.workspace_id ? store.nicknamesByWorkspace?.[channel.workspace_id] : undefined,
              fallbackRoster: dmParticipants(channel),
            });
            return {
              hit,
              where: whereFor(hit, channel, selfId, store.membersById ?? {}),
              who: author.known ? author.name : 'someone',
              avatarUrl: author.avatarUrl,
              kind: author.kind ?? null,
              parentName: author.parentName ?? null,
            };
          });
          setRows(next);
          setStatus(next.length === 0 ? 'empty' : 'results');
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === 'AbortError') return;
          setStatus('error');
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open, token, attempt]);

  const grouped = useMemo(() => groupRows(rows), [rows]);

  // The hit's tokens resolve the way the timeline resolves them: the same
  // mention chain (roster nickname/username, then the session self) and the
  // same channel lookup as ChannelMentionPill — so a hit never shows the wire's
  // raw `<@id>` / `<#id>`.
  const resolveUser = useMemo(() => {
    const s = defaultStore.getState();
    return createMentionResolver(s.membersById ?? {}, s.currentUser ?? null);
  }, [rows]);
  const resolveChannel = useMemo(() => (id: string) => channelNameOf(defaultStore, id), []);
  const terms = termsOf(query);

  const jump = (row: Row) => {
    const href = messagePermalinkUrl(
      {
        id: row.hit.message_id,
        channel_id: row.hit.channel_id,
        thread_id: row.hit.thread_id ?? null,
      },
      row.hit.workspace_id ?? null,
    );
    if (!href) return;
    onOpenChange(false);
    // The permalink is a full URL; the hash router wants the fragment.
    window.location.hash = href.slice(Math.max(0, href.indexOf('#'))).replace(/^#/, '');
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      className="omni-panel"
      aria-describedby={undefined}
      showCloseButton={false}
    >
      <div data-testid="omnisearch" className="omni-body">
        <div className="omni-input-row">
          <span className="omni-glyph" aria-hidden="true">
            ⌕
          </span>
          <CommandInput
            className="omni-input"
            placeholder="Search messages and DMs…"
            value={query}
            onValueChange={setQuery}
            data-testid="omni-input"
            aria-label="Search messages and direct messages"
            spellCheck={false}
          />
          <kbd className="omni-kbd">esc</kbd>
          {/* The house ✕ every other dialog wears, in the query row (the
              wrapper's default was a lucide X floating over the esc hint). */}
          <DialogClose className="modal-close omni-close" aria-label="Close search" data-testid="omni-close">
            ✕
          </DialogClose>
        </div>

        {status === 'idle' && query.trim().length < MIN_QUERY ? (
          <p className="omni-empty" data-testid="omni-hint">
            Search every message you can read — workspaces and DMs.
          </p>
        ) : null}

        {/* The shared pane states (app/ui/PaneStates): the result-row skeleton
            and the one banner + Retry every pane uses. */}
        {status === 'loading' ? (
          <PaneSkeleton label="Searching" testId="omni-loading" variant="message" rows={3} />
        ) : null}

        {status === 'error' ? (
          <div className="px-3 py-2">
            <PaneErrorBanner
              testId="omni-error"
              retryTestId="omni-retry"
              message="Could not search — check your connection and try again."
              onRetry={() => setAttempt((n) => n + 1)}
            />
          </div>
        ) : null}

        {status === 'empty' ? (
          <CommandEmpty className="omni-empty" data-testid="omni-empty">
            No results for “{query.trim()}”.
          </CommandEmpty>
        ) : null}

        {status === 'results' ? (
          <CommandList>
            {grouped.map((group) => (
              <CommandGroup
                key={group.label}
                heading={group.label}
                className="omni-group"
                data-testid={`omni-group-${group.key}`}
              >
                {group.rows.map((row) => (
                  <CommandItem
                    key={row.hit.message_id}
                    value={row.hit.message_id}
                    className="omni-row"
                    data-testid={`omni-result-${row.hit.message_id}`}
                    data-kind={row.hit.kind}
                    onSelect={() => jump(row)}
                  >
                    <span className="omni-where" aria-hidden="true">
                      {/* A channel keeps its sigil; a DM is named by the
                          person, the way the DM list names it — no "@handle". */}
                      {row.hit.kind === 'dm' ? '' : '#'}
                      {row.where}
                    </span>
                    {/* Author + snippet travel together: one line on a wide
                        palette, the full second line on a phone. */}
                    <span className="omni-byline">
                      {/* The author at the thread/call-row step (20px). Decorative:
                          the name beside it is the attribution. */}
                      <Avatar
                        id={row.hit.author_id}
                        name={row.who}
                        src={row.avatarUrl}
                        kind={row.kind}
                        parentName={row.parentName}
                        className="omni-avatar"
                        aria-hidden="true"
                        data-testid="omni-avatar"
                      />
                      <span className="omni-snippet">
                        <span className="omni-author">{row.who}</span>
                        <MentionExcerpt
                          text={truncate(row.hit.content)}
                          resolveUser={resolveUser}
                          resolveChannel={resolveChannel}
                          renderText={(run) => <Highlight text={run} terms={terms} />}
                        />
                      </span>
                    </span>
                    {/* The message row's stamp ("Yesterday, 2:30 PM"): a hit
                        is a message, so it reads its age the same way. */}
                    <span className="omni-time">{formatMessageStamp(row.hit.created_at, now)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        ) : null}
      </div>
    </CommandDialog>
  );
}

/** Group label + rows in server order (workspace hits by score, DMs by recency). */
function groupRows(rows: Row[]): Array<{ key: string; label: string; rows: Row[] }> {
  const out: Array<{ key: string; label: string; rows: Row[] }> = [];
  for (const row of rows) {
    const key = row.hit.kind === 'dm' ? 'dm' : 'workspace';
    const label = row.hit.kind === 'dm' ? 'Direct Messages' : 'Messages';
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else out.push({ key, label, rows: [row] });
  }
  return out;
}

function whereFor(
  hit: OmniHit,
  channel:
    | { name?: string | null; recipients?: Array<{ id: string; username?: string | null }> | null }
    | undefined,
  selfId: string | null,
  membersById: Record<string, { nickname?: string | null; username?: string | null } | undefined>,
): string {
  if (hit.kind === 'dm') {
    // The list surfaces' name chain (nickname, then handle), then the DM's
    // own recipient and name — `||` throughout, so an empty string never
    // reads as a name.
    const peer = channel?.recipients?.find((r) => r.id !== selfId);
    const member = peer ? membersById[peer.id] : undefined;
    return displayNameOf(member) || displayNameOf(peer) || channel?.name || 'Unknown';
  }
  return channel?.name || 'a channel';
}

/** Query terms for highlighting: words ≥2 chars, longest first. */
function termsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
}

/** Render the snippet with query terms emphasized. Plain segments — no HTML. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0 || !text) return <>{text}</>;

  const lower = text.toLowerCase();
  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term, from);
      if (at === -1) break;
      marks.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  marks.sort((a, b) => a[0] - b[0]);

  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of marks) {
    if (start < cursor) continue; // overlapping — the earlier term won
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });

  const limited = parts.slice(0, 24);
  return (
    <>
      {limited.map((part, i) =>
        part.hit ? (
          <mark key={i} className="omni-mark">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  // Never slice a mention token in half — the tail would render raw.
  const open = cut.lastIndexOf('<');
  if (open !== -1 && cut.indexOf('>', open) === -1) cut = cut.slice(0, open);
  return cut + '…';
}
