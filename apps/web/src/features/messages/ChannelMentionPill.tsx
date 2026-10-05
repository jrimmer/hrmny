/**
 * @cytale/web — a `<#channel>` token in a message body, rendered as a pill.
 *
 * The token carries the channel ID only (Discord's form: names are mutable),
 * so the name is resolved at render time from the reader's own store. A known
 * workspace channel renders `#name` as an in-app link to it. Anything else (a
 * DM, a deleted channel, a channel this reader cannot see) renders
 * `#unknown-channel`. The store only ever holds channels the reader can see,
 * so a pill can never disclose a private channel's name to someone outside
 * it: that name was never theirs to resolve.
 *
 * Injected into `renderMarkdownBlocks` rather than imported there, like the
 * permalink chip: the markdown renderer is the DOM half the mobile parity
 * suite executes, and the store may not enter that graph.
 */

import { useSyncExternalStore } from 'react';

import { defaultStore, type StateStore } from '@cytale/state';

/** The in-app route to a workspace channel (the router's own shape). */
export function channelHref(workspaceId: string, channelId: string): string {
  return `#/workspace/${workspaceId}/channel/${channelId}`;
}

/**
 * A workspace channel's name from the reader's store, or undefined for
 * anything the pill would show as `#unknown-channel`.
 */
export function channelNameOf(store: StateStore, channelId: string): string | undefined {
  const channel = store.getState().channels[channelId];
  return channel && channel.type === 'text' && channel.workspace_id ? channel.name : undefined;
}

export function ChannelMentionPill({
  channelId,
  store = defaultStore,
}: {
  channelId: string;
  store?: StateStore;
}) {
  const channel = useSyncExternalStore(
    store.subscribe,
    () => store.getState().channels[channelId],
    () => store.getState().channels[channelId],
  );

  if (!channel || channel.type !== 'text' || !channel.workspace_id) {
    return (
      <span className="mention channel-mention is-unknown" data-channel-id={channelId}>
        #unknown-channel
      </span>
    );
  }

  return (
    <a
      className="mention channel-mention"
      href={channelHref(channel.workspace_id, channelId)}
      data-channel-id={channelId}
    >
      #{channel.name}
    </a>
  );
}
