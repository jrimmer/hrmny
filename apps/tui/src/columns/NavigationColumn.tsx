/**
 * @cytale/tui — column one: the navigation list (U6; R15, R16, R17, R25, R26a).
 *
 * One projection, two modes, and no data path of its own: `buildNavigationList`
 * reads the SHARED store's slices (the same ones `@cytale/state` folds gateway
 * events and REST hydration into) and produces the rows this column draws. U12
 * owns filling that store; nothing here fetches, caches, or derives messages.
 *
 * ---------------------------------------------------------------------------
 * The ordering, and where it comes from
 * ---------------------------------------------------------------------------
 *
 * Channels mode groups the ACTIVE workspace's channels the way `apps/web`'s
 * sidebar does, because two clients over one product must not disagree about
 * where a channel is:
 *
 *   * an uncategorised channel (no `parent_id`, or one naming a category that
 *     does not exist) renders first under NO header;
 *   * then each category, in position order, as a header with its children
 *     beneath it;
 *   * categories with no channels are not drawn at all — a header over nothing
 *     is a dead row.
 *
 * Then the workspace's members, with presence (R25). Channel rows carry `#`;
 * DM rows carry the peer's display name and the peer's presence, because a DM
 * row IS a member.
 *
 * DMs mode lists conversations ACCOUNT-WIDE (R17) — not scoped to the active
 * workspace — in recency order, using the store's narrow recency slice with the
 * channel row's own `last_message_id` as the fallback, exactly as the web
 * client's home column does.
 *
 * ---------------------------------------------------------------------------
 * Every string from the server is inert (R26a)
 * ---------------------------------------------------------------------------
 *
 * Channel, workspace, member, and DM peer names are a member's to set, so each
 * one crosses `sanitizeTerminalText` HERE, at projection time, before it can
 * reach a cell. A name whose sanitized form is empty falls back to a label that
 * says what the row is (`unnamed channel`) rather than rendering a nameless row
 * — the sanitizer removes sequences, it never invents text.
 *
 * Empty states name what is missing and where to go, including the browser URL
 * for a member with no workspace at all (R14's origin): the terminal cannot
 * accept an invite, so it must say who can.
 *
 * ---------------------------------------------------------------------------
 * U10: the unread badge (R22, R22a)
 * ---------------------------------------------------------------------------
 *
 * A channel or DM row carries the count the SERVER reports for it, and the
 * count arrives through ONE seam: `NavigationInput.unreadCount`, which the
 * shell binds to `readState.ts`'s `readBadge` (→ `@cytale/state`'s
 * `deriveChannelBadge`). The column never derives a count of its own and never
 * reads a message slice to invent one — for a channel the client has never
 * loaded there is no slice to read, which is exactly the channel R22a's badge
 * is for. Unwired, the seam is absent and every row renders without a badge:
 * no fake count stands in for a source nobody connected.
 *
 * The badge is drawn WITHIN the row's cells (U10's `UnreadBadge.labelForRow`
 * reserves them and truncates the name instead), because Ink clips from the
 * right: a suffix on a long channel name would otherwise be the first thing to
 * vanish. It is also never a row of its own — column one's selection is an
 * INDEX into `selectableIds`, so a row that appeared or disappeared as unread
 * changed would move the member's cursor under them.
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { Channel, Workspace, WorkspaceMember } from '@cytale/domain';
import type { PresenceStatus } from '@cytale/protocol';

import { displayWidth } from '../format/markdown.js';
import {
  FOCUS_MARKER,
  MODE_LABELS,
  focusMarker,
  inertText,
  type ShellMode,
} from './layout.js';
import { readPresence, type PresenceLink } from './Presence.js';
import { NO_BADGE, UnreadBadge, labelForRow } from './UnreadBadge.js';
import { displayNameOf } from '@cytale/domain';

// ---------------------------------------------------------------------------
// Presence (R25)
// ---------------------------------------------------------------------------
//
// The glyph table and `presenceGlyph` live in `columns/Presence.js` (U15). They
// were defined here first, and moved when this column needed to draw a stale
// reading: the call site has to ask that module, and it was importing the table
// from here, so leaving them put would have made the two files import each
// other. Presence logic lives with the presence code.

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/** The store slices column one reads (structurally — the real state satisfies it). */
export interface NavigationSource {
  readonly workspaces: Record<string, Workspace>;
  readonly channels: Record<string, Channel>;
  readonly membersById: Record<string, WorkspaceMember>;
  readonly memberIdsByWorkspace: Record<string, readonly string[]>;
  /** Per-workspace nicknames (#169); absent in fixtures that predate them. */
  readonly nicknamesByWorkspace?: Record<string, Record<string, string>> | undefined;
  /** The live recency slice (U17); falls back to the channel row's own field. */
  readonly lastMessageIdByChannel?: Record<string, string> | undefined;
  readonly presenceByUser?: Record<string, { status: PresenceStatus } | undefined> | undefined;
}

/** A row in column one. Only `channel` and `dm` rows are selectable. */
export type NavigationRow =
  | { readonly kind: 'header'; readonly label: string }
  | {
      readonly kind: 'channel';
      readonly id: string;
      readonly label: string;
      /** The server's unread count (U10); `0` draws nothing. */
      readonly badge: number;
    }
  | {
      readonly kind: 'dm';
      readonly id: string;
      readonly label: string;
      readonly presence: PresenceStatus | null;
      /** A DM is a channel in the store, so it carries the same badge (U10). */
      readonly badge: number;
    }
  | {
      readonly kind: 'member';
      readonly id: string;
      readonly label: string;
      readonly presence: PresenceStatus | null;
    };

export interface NavigationList {
  readonly rows: readonly NavigationRow[];
  /** The selectable row ids, in the order the movement keys walk them. */
  readonly selectableIds: readonly string[];
  /** The one-line empty state, when there is nothing to select. */
  readonly empty: string | null;
}

export interface NavigationInput {
  readonly mode: ShellMode;
  readonly source: NavigationSource;
  readonly activeWorkspaceId: string | null;
  readonly viewerId: string | null;
  /** The client's origin: the browser URL a member with no workspace needs. */
  readonly origin: string;
  /**
   * The server's unread count for a conversation (U10; R22a). The shell binds
   * this to `readState.ts`'s `readBadge`, so the number column one draws is the
   * server's for every channel — including the channels this client has loaded
   * no messages for, which is the case the badge exists to cover. Absent, no
   * row carries a badge.
   */
  readonly unreadCount?: ((channelId: string) => number) | undefined;
}

const byPosition = (a: Channel, b: Channel): number =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Decimal-string snowflake compare, newest first; anything unparsable sinks. */
function snowflakeDesc(a: string | null | undefined, b: string | null | undefined): number {
  const value = (raw: string | null | undefined): bigint =>
    raw !== null && raw !== undefined && /^\d+$/.test(raw) ? BigInt(raw) : -1n;
  const av = value(a);
  const bv = value(b);
  if (av > bv) return -1;
  if (av < bv) return 1;
  return 0;
}

/** The DM row's peer: the recipient that is not the viewer. */
function dmPeer(channel: Channel, viewerId: string | null): { id: string; name: string } {
  const recipient = channel.recipients?.find((candidate) => candidate.id !== viewerId);
  return {
    id: recipient?.id ?? channel.id,
    // A deleted peer leaves no username: fall back to the channel's own name.
    name: inertText(recipient?.username ?? channel.name, 'Conversation'),
  };
}

/**
 * Column one for one mode: the rows to draw, the ids movement walks, and the
 * empty state when there are none.
 */
export function buildNavigationList(input: NavigationInput): NavigationList {
  const { mode, source, activeWorkspaceId, viewerId, origin } = input;
  const rows: NavigationRow[] = [];
  const selectableIds: string[] = [];
  const push = (row: NavigationRow, selectable: boolean): void => {
    rows.push(row);
    if (selectable && (row.kind === 'channel' || row.kind === 'dm')) selectableIds.push(row.id);
  };

  // The unread count, from the CALLER's reader (U10). Absent = no badges, never
  // a locally invented count (see the header).
  const unreadCount = input.unreadCount ?? ((): number => NO_BADGE);

  const presenceOf = (userId: string): PresenceStatus | null =>
    source.presenceByUser?.[userId]?.status ?? null;

  if (mode === 'dms') {
    const dms = Object.values(source.channels)
      .filter((channel) => channel.type === 'dm')
      .sort(
        (a, b) =>
          snowflakeDesc(
            source.lastMessageIdByChannel?.[a.id] ?? a.last_message_id,
            source.lastMessageIdByChannel?.[b.id] ?? b.last_message_id,
          ) || snowflakeDesc(a.id, b.id),
      );
    for (const dm of dms) {
      const peer = dmPeer(dm, viewerId);
      push(
        {
          kind: 'dm',
          id: dm.id,
          label: peer.name,
          presence: presenceOf(peer.id),
          badge: unreadCount(dm.id),
        },
        true,
      );
    }
    return {
      rows,
      selectableIds,
      empty:
        selectableIds.length > 0
          ? null
          : // V1 reads and replies to existing conversations; the web client owns
            // opening a new one, so the terminal names it rather than offering it.
            `No direct messages yet — open one at ${origin}/ and it appears here.`,
    };
  }

  const workspaces = Object.values(source.workspaces);
  if (workspaces.length === 0) {
    return {
      rows,
      selectableIds,
      empty: `No workspaces yet — open ${origin}/ in a browser to create one or accept an invite.`,
    };
  }

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? workspaces[0];
  if (workspace === undefined) return { rows, selectableIds, empty: null };

  const channels = Object.values(source.channels).filter(
    (channel) => channel.workspace_id === workspace.id,
  );
  const categories = channels.filter((channel) => channel.type === 'category').sort(byPosition);
  const texts = channels.filter((channel) => channel.type === 'text').sort(byPosition);
  const parentless = texts.filter(
    (channel) => !categories.some((category) => category.id === channel.parent_id),
  );

  // Parentless channels first, under no header (the web sidebar's layout).
  for (const channel of parentless) {
    push(
      {
        kind: 'channel',
        id: channel.id,
        label: `#${inertText(channel.name, 'unnamed-channel')}`,
        badge: unreadCount(channel.id),
      },
      true,
    );
  }
  for (const category of categories) {
    const children = texts.filter((channel) => channel.parent_id === category.id);
    if (children.length === 0) continue;
    push({ kind: 'header', label: inertText(category.name, 'Unnamed category') }, false);
    for (const channel of children) {
      push(
        {
          kind: 'channel',
          id: channel.id,
          label: `#${inertText(channel.name, 'unnamed-channel')}`,
          badge: unreadCount(channel.id),
        },
        true,
      );
    }
  }

  // The workspace's members, with presence (R25). Members are a readout, not a
  // destination: V1 starts no new DMs, so they are not selectable.
  const members = (source.memberIdsByWorkspace[workspace.id] ?? [])
    .map((id) => source.membersById[id])
    .filter((member): member is WorkspaceMember => member !== undefined)
    .map((member) => ({
      member,
      label: inertText(
        displayNameOf({ ...member, nickname: source.nicknamesByWorkspace?.[workspace.id]?.[member.id] ?? null }),
        'unnamed member',
      ),
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.member.id.localeCompare(b.member.id));
  if (members.length > 0) {
    push({ kind: 'header', label: 'Members' }, false);
    for (const { member, label } of members) {
      push({ kind: 'member', id: member.id, label, presence: presenceOf(member.id) }, false);
    }
  }

  return {
    rows,
    selectableIds,
    empty:
      selectableIds.length > 0
        ? null
        : // An empty workspace is not an error: the member's DMs are still
          // reachable, so the empty state points at them instead of dead-ending.
          `${inertText(workspace.name, 'This workspace')} has no channels yet — press m for your direct messages.`,
  };
}

// ---------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------

/**
 * What column one knows about the load feeding it (U12 owns the fetch).
 *
 * The phases are U12's hydration snapshot's own (`session/hydration.ts`), and
 * the fields a caller needs are that snapshot's, so the boot load's snapshot
 * satisfies this type directly: the shell renders the load's states instead of
 * inventing a second vocabulary for them. The distinction the plan insists on
 * survives here — an `empty` account (the correct state for a member whose
 * invite is pending) is NOT a `failed` read, and a failed DM read degrades the
 * DM list without touching the channels.
 */
export interface NavigationStatus {
  readonly phase: 'idle' | 'loading' | 'ready' | 'empty' | 'failed';
  /** `empty`: where a member can create a workspace (the browser URL). */
  readonly notice?: string | null;
  /** `failed`: the workspace list could not be read, in the client's own words. */
  readonly error?: string | null;
  /** `failed`: the transport cause, shown after the reason — never instead. */
  readonly errorDetail?: string | null;
  /** The account-wide DM read failed: only DMs mode carries that error. */
  readonly dmsFailed?: boolean;
}

export const NAVIGATION_READY: NavigationStatus = { phase: 'ready' };
export const NAVIGATION_LOADING: NavigationStatus = { phase: 'loading' };

/** What the list area shows: the rows, or why it cannot show them. */
export type NavigationListState = 'loading' | 'ready' | 'empty' | 'error';

/**
 * The load's phase AS the list it feeds. Channels mode takes the workspace
 * read's outcome; DMs mode is account-wide (R17), so it stands or falls on its
 * own read — a member whose workspace list failed still has their DMs.
 */
export function navigationListState(status: NavigationStatus, mode: ShellMode): NavigationListState {
  if (mode === 'dms') {
    if (status.dmsFailed === true) return 'error';
    return status.phase === 'idle' || status.phase === 'loading' ? 'loading' : 'ready';
  }
  switch (status.phase) {
    case 'idle':
    case 'loading':
      return 'loading';
    case 'empty':
      return 'empty';
    case 'failed':
      return 'error';
    default:
      return 'ready';
  }
}

export interface NavigationColumnProps {
  readonly mode: ShellMode;
  /** The active workspace's name (its band in the header); null in DMs mode. */
  readonly workspaceName: string | null;
  readonly focused: boolean;
  readonly list: NavigationList;
  /** Index into `list.selectableIds`. */
  readonly selectedIndex: number;
  readonly status: NavigationStatus;
  readonly width: number;
  readonly height: number;
  /**
   * Whether the gateway link behind the rows' presence is current (U15).
   * Required rather than defaulted: a call site that forgot it would draw a
   * stale reading as live, which is the one thing this prop exists to stop.
   */
  readonly presenceLink: PresenceLink;
}

/** The first row to draw so the selected row stays on screen. */
function windowStart(rows: number, selected: number, budget: number): number {
  if (rows <= budget) return 0;
  return Math.max(0, Math.min(selected - budget + 1, rows - budget));
}

export function NavigationColumn({
  mode,
  workspaceName,
  focused,
  list,
  selectedIndex,
  status,
  width,
  height,
  presenceLink,
}: NavigationColumnProps): ReactElement {
  const band = inertText(workspaceName, '');
  const title = `${MODE_LABELS[mode]} mode${mode === 'channels' && band !== '' ? ` · ${band}` : ''}`;
  const head = `${focusMarker('navigation', focused ? 'navigation' : 'content')} ${title}`;

  const selectedRow = list.selectableIds.length === 0 ? -1 : selectedIndex;
  let selectableSeen = -1;
  const marked = list.rows.map((row) => {
    if (row.kind === 'channel' || row.kind === 'dm') {
      selectableSeen += 1;
      return selectableSeen === selectedRow;
    }
    return false;
  });

  const start = windowStart(list.rows.length, Math.max(0, selectedRow), Math.max(1, height - 1));
  const visible = list.rows.slice(start, start + Math.max(1, height - 1));

  // The one line the list area shows when it is not showing rows. Every branch
  // is a fact about the LOAD, so an empty account and a failed read never read
  // the same way (the plan's partial-failure contract, U12).
  const state = navigationListState(status, mode);
  const message: string | null =
    state === 'loading'
      ? mode === 'dms'
        ? 'Loading your direct messages…'
        : 'Loading your workspaces…'
      : state === 'error'
        ? mode === 'dms'
          ? 'Could not load your direct messages.'
          : inertText(status.error ?? '', 'Could not load your workspaces.')
        : state === 'empty'
          ? inertText(status.notice ?? '', list.empty ?? 'This account has no workspaces yet.')
          : list.empty;

  return (
    <Box flexDirection="column" width={width}>
      <Text bold={focused} dimColor={!focused} wrap="truncate">
        {head}
      </Text>
      {message !== null ? (
        <Text wrap="wrap">{`  ${inertText(message, 'Nothing to show yet.')}`}</Text>
      ) : (
        visible.map((row, offset) => {
          const index = start + offset;
          const current = marked[index] === true;
          const marker = current ? FOCUS_MARKER : ' ';
          if (row.kind === 'header') {
            return (
              <Text key={`${row.kind}:${index}`} wrap="truncate" dimColor>
                {`  ${row.label}`}
              </Text>
            );
          }
          // A member row is a readout, not a conversation: it has no unread
          // state, and its prefix spends three cells on the presence glyph.
          const badge = row.kind === 'channel' || row.kind === 'dm' ? row.badge : NO_BADGE;
          const prefix =
            row.kind === 'channel'
              ? `${marker} `
              : `${marker} ${readPresence(row.presence, presenceLink).glyph} `;
          // The name is cut to what the row's own cells leave, so the badge —
          // the point of the row — is never the part Ink's clip takes.
          const cells = Math.max(0, width - displayWidth(prefix));
          return (
            <Text key={`${row.kind}:${index}`} wrap="truncate" bold={current}>
              {prefix}
              {labelForRow(row.label, badge, cells)}
              <UnreadBadge count={badge} />
            </Text>
          );
        })
      )}
      {state === 'error' && inertText(status.errorDetail, '') !== '' ? (
        <Text dimColor wrap="wrap">{`  ${inertText(status.errorDetail, '')}`}</Text>
      ) : null}
    </Box>
  );
}
