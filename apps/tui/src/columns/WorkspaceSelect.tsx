/**
 * @cytale/tui — the workspace model and its chooser (U6; R15, R16, step 2).
 *
 * One workspace is active per session. The choice is CLIENT-LOCAL state — it is
 * a view preference, and a fresh Identify resets the shared store anyway — so
 * the model lives here, over whatever workspace list the store currently holds,
 * rather than as a field other clients would have to agree on:
 *
 *   * `resolveActiveWorkspaceId` keeps the member's choice while it is still in
 *     the list and re-derives it (the first workspace, in the store's server
 *     order) when it is not — a re-derivation, never a dangling reference.
 *   * `needsWorkspaceSelection` is false for fewer than two workspaces, so a
 *     member with one workspace proceeds without a selection step, and a member
 *     with none still reaches their DMs through `m`.
 *
 * `WorkspaceSelect` is the chooser itself: a keyboard-driven overlay opened by
 * the shell's `w` binding and rendered from the same list. It takes no
 * callbacks — the shell owns the keys, and a terminal has no pointer for a
 * component to own.
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { Workspace } from '@cytale/domain';

import { sanitizeTerminalText } from '../format/markdown.js';

import { FOCUS_MARKER } from './layout.js';

/** What the model needs from a workspace: its identity. */
export interface WorkspaceLike {
  readonly id: string;
}

/**
 * The workspace the session should have active, given what the member chose and
 * what the store now holds.
 */
export function resolveActiveWorkspaceId(
  current: string | null,
  workspaces: readonly WorkspaceLike[],
): string | null {
  if (current !== null && workspaces.some((workspace) => workspace.id === current)) return current;
  return workspaces[0]?.id ?? null;
}

/** True only when there is a choice to make (step 2's "no selection step"). */
export function needsWorkspaceSelection(workspaces: readonly WorkspaceLike[]): boolean {
  return workspaces.length > 1;
}

export interface WorkspaceSelectProps {
  readonly workspaces: readonly Workspace[];
  readonly activeWorkspaceId: string | null;
  /** The overlay's cursor: where Enter would land. */
  readonly cursor: number;
  readonly width: number;
}

/**
 * The chooser. The active workspace is named as well as marked, because the
 * marker is a cursor and not a statement about which workspace is in use.
 */
export function WorkspaceSelect({
  workspaces,
  activeWorkspaceId,
  cursor,
  width,
}: WorkspaceSelectProps): ReactElement {
  return (
    <Box flexDirection="column" width={width}>
      <Text bold>Choose a workspace</Text>
      {workspaces.map((workspace, index) => {
        const name = sanitizeTerminalText(workspace.name);
        const label = name.trim() === '' ? 'unnamed workspace' : name;
        const current = workspace.id === activeWorkspaceId;
        return (
          <Text key={workspace.id} wrap="truncate" {...(index === cursor ? { bold: true } : {})}>
            {`${index === cursor ? FOCUS_MARKER : ' '} ${label}${current ? ' — current' : ''}`}
          </Text>
        );
      })}
      <Text dimColor>{'Enter chooses · Esc closes'}</Text>
    </Box>
  );
}
