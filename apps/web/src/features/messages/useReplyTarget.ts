/**
 * @cytale/web — the inline-reply target (Discord semantics), shared by the
 * channel pane and the thread panel so a reply starts, reads and cancels the
 * same way in both.
 *
 * - `startReply(message, {suppressPing})` resolves the author's name the way
 *   the rows do (a DM's own participants first, the workspace roster after,
 *   the session's own identity for self-replies — never a raw snowflake) and
 *   a mention-resolved 80-character snippet. Shift+click on the hover arrow
 *   starts with the ping suppressed.
 * - `togglePing` flips the reply bar's @ toggle; `cancelReply` clears it.
 * - Escape cancels the reply from ANYWHERE while one is active (focus often
 *   sits on the hover-action button, not the composer). Bubble phase on
 *   purpose: an open composer palette consumes Escape first (it stops the
 *   key in the editor), so Escape closes the palette before the reply.
 */

import { useCallback, useEffect, useState } from 'react';

import type { Message } from '@cytale/domain';
import { previewText, resolveMentionTokens } from '@cytale/markdown';
import type { StateStore } from '@cytale/state';
import { nicknamesForChannel } from '@cytale/state';

import { resolveAuthor } from './authorIdentity.js';
import { dmParticipants } from './dmRoster.js';
import type { ReplyTarget } from './MessageCompose.js';
import type { MessageWithBots } from './types.js';
import { displayNameOf } from '@cytale/domain';

export interface UseReplyTarget {
  replyTo: ReplyTarget | null;
  startReply: (message: Message, opts?: { suppressPing?: boolean }) => void;
  cancelReply: () => void;
  togglePing: () => void;
}

export function useReplyTarget(store: StateStore | undefined, channelId: string | null): UseReplyTarget {
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);

  const startReply = useCallback(
    (message: Message, opts?: { suppressPing?: boolean }) => {
      const state = store?.getState();
      // DM peers live in the channel's OWN recipients (dmRoster.ts), not the
      // workspace roster — resolving only membersById rendered a DM reply as
      // the peer's raw snowflake (owner report 2026-09-15). Same order the
      // message rows use: DM participants first, workspace roster after.
      const dm = dmParticipants(state?.channels[channelId ?? '']);
      const roster = { ...state?.membersById, ...dm };
      // The shared resolver (authorIdentity.ts): a webhook's own name, then
      // the roster row (people and bots alike), then the session self —
      // self-replies never render the raw snowflake when the people roster
      // hasn't hydrated.
      const nicknames = state ? nicknamesForChannel(state, channelId) : undefined;
      const author = resolveAuthor(roster, message.author_id, {
        self: state?.currentUser ?? null,
        nicknames,
        override: (message as MessageWithBots).author_override ?? null,
      });
      // The SNIPPET resolves mention tokens the way the rows do: a raw
      // <@snowflake> in the preview reads as an id.
      const nameOf = (id: string): string => {
        if (state?.currentUser && state.currentUser.id === id) return state.currentUser.username;
        const m = dm[id] ?? state?.membersById[id];
        return m ? displayNameOf({ ...m, nickname: nicknames?.[id] ?? null }) : id;
      };
      // The shared preview (markup dropped, tokens named), THEN the cap: it
      // used to cap first, which could cut a token in half and print it raw,
      // and it left `<#id>` and all markdown unresolved.
      const plain = resolveMentionTokens(previewText(message.content), nameOf, (id) => {
        const c = state?.channels[id];
        return c && c.type === 'text' && c.workspace_id ? (c.name ?? 'unknown-channel') : 'unknown-channel';
      });
      const snippet = plain.length > 80 ? `${plain.slice(0, 79).trimEnd()}…` : plain;
      setReplyTo({
        messageId: message.id,
        authorId: message.author_id,
        authorName: author.name,
        snippet,
        ping: opts?.suppressPing !== true,
      });
    },
    [store, channelId],
  );

  // Stable: props of the memoized composer.
  const cancelReply = useCallback(() => setReplyTo(null), []);
  const togglePing = useCallback(() => {
    setReplyTo((r) => (r ? { ...r, ping: !r.ping } : r));
  }, []);

  useEffect(() => {
    if (!replyTo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setReplyTo(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [replyTo]);

  return { replyTo, startReply, cancelReply, togglePing };
}
