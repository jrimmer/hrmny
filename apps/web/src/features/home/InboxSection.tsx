/**
 * @cytale/web — Home's mention inbox (#117).
 *
 * "Where was I needed", not "what is new". Home's stat cards and the catch-up
 * rollup already answer the second question at CHANNEL granularity ("#release
 * has 4 unread"); this section is the message-level answer the ticket is named
 * for — who addressed whom, with the sentence, and a link straight to it.
 *
 * Three things it deliberately is NOT (the ticket's non-goals, in code):
 *
 *   * not a second set of unread numbers — the rows are events with no count,
 *     and the channel badges keep coming from the one watermark;
 *   * not a duplicate of the catch-up rollup — every row is a MESSAGE, and the
 *     channel names here are addresses, not a per-channel tally;
 *   * not anyone else's inbox — the server's rows are keyed by the member, so
 *     there is no view of this section that could hold another person's
 *     mentions.
 *
 * Rows are links (`#114`'s permalinks), so a row opens the message — right-
 * click/copy included — without this file knowing anything about routing. The
 * surface owns its states-first set: loading, empty, error (with retry), a
 * failed done, and the awaiting-answer list.
 */

import { useMemo } from 'react';

import type { PrincipalKind } from '@cytale/domain';

import { Avatar, kindTitle } from '../../app/ui/UserAvatar.js';
import { PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { formatRelative } from '../../app/ui/time.js';

import { resolveAuthor } from '../messages/authorIdentity.js';
import { messagePermalinkUrl } from '../messages/messagePermalink.js';
import { MentionExcerpt, excerptPlainText } from '../messages/MentionExcerpt.js';
import type { InboxItem } from './inbox.js';
import type { InboxStatus } from './useInbox.js';

/** The store slice the section reads (structural, so tests can build one). */
export interface InboxStore {
  channels: Record<string, { name?: string | null; type?: string; workspace_id?: string | null }>;
  membersById?: Record<
    string,
    | {
        username: string;
        nickname?: string | null;
        avatar_url?: string | null;
        /** Principal kind and owner — a machine author wears the agent seal. */
        kind?: PrincipalKind | null;
        parent_user_id?: string | null;
      }
    | undefined
  >;
  /** Per-workspace nicknames (#169): an item names its author for its channel's workspace. */
  nicknamesByWorkspace?: Record<string, Record<string, string>>;
}

export interface InboxSectionProps {
  store: InboxStore;
  items: InboxItem[];
  status: InboxStatus;
  error?: string | null;
  actionError?: string | null;
  busy?: boolean;
  onDismiss: (messageId: string) => void;
  onSweep: () => void;
  onRetry: () => void;
  /**
   * Which column the section is rendered into. `column` = Home's sidebar,
   * where the heading takes the same `.category-label` idiom as Direct
   * Messages / Mentions / Threads; `dashboard` = the wider body, which keeps
   * its own `.home-section-label`. Both headings read "Inbox".
   */
  variant?: 'column' | 'dashboard';
  /** Fixed clock for the "when" column (tests pin it; production uses now). */
  now?: number;
}

/** The shared relative stamp (app/ui/time.ts), under the name the tests import. */
export const relativeTime = (iso: string | null | undefined, now: number): string =>
  formatRelative(iso, now);

export function InboxSection({
  store,
  items,
  status,
  error = null,
  actionError = null,
  busy = false,
  onDismiss,
  onSweep,
  onRetry,
  variant = 'dashboard',
  now = Date.now(),
}: InboxSectionProps) {
  // The excerpt's tokens resolve like the timeline's: user tokens by roster
  // name, channel tokens the way ChannelMentionPill does (a workspace text
  // channel the reader can see, else `#unknown-channel`).
  const resolvers = useMemo(
    () => ({
      resolveUser: (userId: string) => {
        const who = resolveAuthor(store.membersById, userId);
        return who.known ? who.name : 'someone';
      },
      resolveChannel: (channelId: string) => {
        const c = store.channels[channelId];
        return c && c.type === 'text' && c.workspace_id ? (c.name ?? undefined) : undefined;
      },
    }),
    [store],
  );

  const sweepButton = (
    <button
      type="button"
      className="home-btn inbox-sweep"
      data-testid="inbox-sweep"
      disabled={busy}
      onClick={onSweep}
    >
      Mark all done
    </button>
  );

  // ALWAYS rendered. This surface used to return null until it had something
  // to say, and a member who had never seen it could not tell whether they had
  // no mentions or no inbox — the owner's report was literally "where's the
  // fancy new inbox". A steady heading with an honest empty line is worth more
  // than the vertical space it costs.
  return (
    <section aria-labelledby="home-inbox-heading" data-testid="home-inbox" data-status={status}>
      {variant === 'column' ? (
        // The COLUMN idiom: same element, padding and tracking as Direct
        // Messages / Mentions / Threads beside it. It used to be an h2 on the
        // dashboard's `.home-section-label`, which sat 8px further left with
        // wider tracking than its own neighbours (owner report 2026-09-15).
        <h3 id="home-inbox-heading" className="category-label">
          Inbox
          {items.length > 0 ? sweepButton : null}
        </h3>
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="home-inbox-heading" className="home-section-label">
            Inbox
          </h2>
          {items.length > 0 ? sweepButton : null}
        </div>
      )}

      {/* The shared pane states (app/ui/PaneStates): one skeleton, one
          banner, one Retry — the inbox used to say "Try again" on a home
          button while every other pane said Retry. */}
      {status === 'loading' ? (
        <PaneSkeleton label="Loading your mentions" testId="inbox-loading" variant="message" rows={2} />
      ) : null}

      {status === 'error' ? (
        <PaneErrorBanner
          testId="inbox-error"
          retryTestId="inbox-retry"
          message={error ?? 'Could not load your mentions.'}
          onRetry={onRetry}
        />
      ) : null}

      {/* `idle` is folded in with `ready`-and-empty on purpose: idle means
          nothing has been asked for yet, and rendering NOTHING there was the
          disappearing act. Silence reads as "no inbox"; the empty line reads
          as "nothing needs you", which is the true and less alarming claim. */}
      {(status === 'ready' || status === 'idle') && items.length === 0 ? (
        <div role="status" className="all-caught-up" data-testid="inbox-empty">
          ✓ Nothing new
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="inbox-list" data-testid="inbox-list">
          {items.map((item) => {
            // The shared resolver (authorIdentity.ts) — the timeline's name
            // chain (nickname, then handle), the row's own wire name next.
            const itemWs = store.channels[item.channel_id]?.workspace_id;
            const author = resolveAuthor(store.membersById, item.author_id, {
              wireName: item.author_username,
              nicknames: itemWs ? store.nicknamesByWorkspace?.[itemWs] : undefined,
            });
            const authorName = author.known ? author.name : 'someone';
            const parentName = author.parentName ?? null;
            const channel = store.channels[item.channel_id];
            const channelName =
              channel?.type === 'dm' ? 'a direct message' : `#${channel?.name ?? 'a channel'}`;
            const href = messagePermalinkUrl(
              { id: item.message_id, channel_id: item.channel_id, thread_id: item.thread_id ?? null },
              channel?.workspace_id ?? null,
            );

            return (
              <li
                key={item.message_id}
                className="inbox-row"
                data-testid={`inbox-item-${item.message_id}`}
              >
                {/* The message timeline's attribution, at the people list's
                    two-line-row size: the hue tile or image, and the agent
                    seal for a machine author. No presence dot — a mention is
                    a message, and message avatars carry none. */}
                <Avatar
                  id={item.author_id}
                  name={authorName}
                  src={author.avatarUrl}
                  kind={author.kind ?? null}
                  parentName={parentName}
                  className="inbox-row-avatar"
                />
                <div className="inbox-row-body">
                  <p className="inbox-row-meta">
                    <span className="inbox-row-author">{authorName}</span>
                    {kindTitle(author.kind, parentName) ? (
                      <span className="sr-only"> ({kindTitle(author.kind, parentName)})</span>
                    ) : null}{' '}
                    mentioned you in{' '}
                    <span className="inbox-row-channel">{channelName}</span>
                    {item.thread_id ? ' in a thread' : ''}
                    {item.created_at ? (
                      <>
                        {' · '}
                        <time dateTime={item.created_at}>{relativeTime(item.created_at, now)}</time>
                      </>
                    ) : null}
                  </p>
                  {href ? (
                    <a className="inbox-row-sentence" href={href}>
                      <MentionExcerpt text={item.excerpt} {...resolvers} />
                    </a>
                  ) : (
                    // A non-snowflake id has no address (the permalink builder
                    // refuses to mint one) — the sentence still renders, it is
                    // just not a link.
                    <span className="inbox-row-sentence"><MentionExcerpt text={item.excerpt} {...resolvers} /></span>
                  )}
                </div>
                <button
                  type="button"
                  className="home-btn inbox-row-done"
                  data-testid={`inbox-done-${item.message_id}`}
                  disabled={busy}
                  aria-label={`Mark done: ${excerptPlainText(item.excerpt, resolvers)}`}
                  onClick={() => onDismiss(item.message_id)}
                >
                  Done
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {actionError ? (
        <p role="alert" className="home-empty" data-testid="inbox-action-error">
          {actionError}
        </p>
      ) : null}
    </section>
  );
}
