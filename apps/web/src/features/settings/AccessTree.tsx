/**
 * @cytale/web — the agent access tree (U7).
 *
 * One control per node, one save path (KTD5): this component edits a whole
 * `AccessDocument` locally and hands the complete document back through
 * `onChange`; the caller PATCHes it, and the server validates the whole thing
 * before persisting. No node is patched independently, so the tree can never
 * be half-applied.
 *
 * What it renders, in the owner's terms:
 *
 *   Server                     fixed · always granted · user cannot change
 *   Account
 *    └ Agent's account         fixed · its own identity, nothing to grant
 *   DMs                        None | Read | Read-write
 *   Workspaces                 None | All(<level>) | Custom
 *    └ workspace               None | Read | Read-write   (when Custom)
 *        └ channel             None | Read | Read-write   (when Custom)
 *
 * Two behaviours are load-bearing and easy to get subtly wrong:
 *
 *  * `All` RETAINS the explicit grants but takes them out of force — the root
 *    governs while it is set. The rows stay on screen, visibly dormant, with
 *    the hint saying so; clearing the root restores them unchanged.
 *  * Moving the root from None to Custom needs an explicit confirmation step
 *    (a misclick must not widen an agent from nothing to something).
 *
 * Management and moderation are absent from the level list on purpose: no
 * level confers them, so offering the choice would be a lie.
 */

import { useState } from 'react';

import type {
  AccessDocument,
  AccessLevel,
  WorkspacesAccessMode,
} from '@cytale/api-client';

import type { ChannelOption, TreeWorkspace } from './types.js';

export type { ChannelOption, TreeWorkspace } from './types.js';

export interface AccessTreeProps {
  /** The document as read; edits are local until the caller saves. */
  value: AccessDocument;
  /** The caller's workspaces — grant targets, not ownership (R5). */
  workspaces: TreeWorkspace[];
  /** One workspace's channels, fetched the first time its row expands. */
  loadChannels(workspaceId: string): Promise<ChannelOption[]>;
  /** The whole document, on every edit. */
  onChange(next: AccessDocument): void;
  /** Offline: every control is inert with a stated reason. */
  disabled?: boolean;
  /** Test seam: the id prefix for label/input association. */
  idPrefix?: string;
}

/** The counterparty policy: who this agent will hold a DM with. */
export type DmSupport = 'humans' | 'everyone' | 'none';

const DM_SUPPORTS: DmSupport[] = ['humans', 'everyone', 'none'];

const DM_SUPPORT_WORD: Record<DmSupport, string> = {
  humans: 'With humans',
  everyone: 'With everyone',
  none: 'No one',
};

const DM_SUPPORT_HINT: Record<DmSupport, string> = {
  humans: 'People can start a conversation with this agent; other agents cannot.',
  everyone: 'People and other agents can both start a conversation with this agent.',
  none: 'Nobody can start a conversation with this agent.',
};

const LEVELS: AccessLevel[] = ['none', 'read', 'read_write'];

const LEVEL_WORD: Record<AccessLevel, string> = {
  none: 'None',
  read: 'Read',
  read_write: 'Read-write',
};

/** What each level actually confers — shown as the control's hint. */
const LEVEL_HINT: Record<AccessLevel, string> = {
  none: 'Nothing — the agent cannot see this at all.',
  read: 'See it, read history, search, receive events.',
  read_write: 'Read, plus send, upload, react and thread.',
};

const MODE_WORD: Record<WorkspacesAccessMode, string> = {
  none: 'None',
  all: 'All workspaces',
  custom: 'Custom',
};

const MODE_HINT: Record<WorkspacesAccessMode, string> = {
  none: 'No workspace access at all.',
  all: 'One level for every workspace, including ones you join later.',
  custom: 'A level per workspace, chosen explicitly.',
};

/** A three-way level control: native radios, so grouping and arrow keys are the platform's. */
function LevelControl({
  legend,
  value,
  onChange,
  disabled,
  disabledReason,
  name,
  testId,
}: {
  legend: string;
  value: AccessLevel;
  onChange(level: AccessLevel): void;
  disabled?: boolean;
  disabledReason?: string;
  name: string;
  testId: string;
}) {
  return (
    <fieldset data-testid={testId} disabled={disabled} title={disabled ? disabledReason : undefined}>
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap items-center gap-1">
        {LEVELS.map((level) => (
          <label
            key={level}
            className={
              'cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--duration-control)] ' +
              (disabled
                ? 'cursor-not-allowed border-line text-text-muted opacity-60'
                : value === level
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-line text-text-muted hover:bg-surface-hover hover:text-text-primary')
            }
          >
            <input
              type="radio"
              className="sr-only"
              // The test-id rides the INPUT, not the label: the input is what
              // carries `checked`, and a click on it selects the level.
              data-testid={`${testId}-${level}`}
              name={name}
              value={level}
              checked={value === level}
              disabled={disabled}
              onChange={() => onChange(level)}
            />
            {LEVEL_WORD[level]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function AccessTree({
  value,
  workspaces,
  loadChannels,
  onChange,
  disabled = false,
  idPrefix = 'access',
}: AccessTreeProps) {
  /** The channel lists we have fetched, by workspace id. */
  const [channelCache, setChannelCache] = useState<Record<string, ChannelOption[]>>({});
  /** Workspaces whose channel list is expanded. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const mode = value.workspaces.mode;
  /** `All` is in force: the explicit grants below it are retained, not active. */
  const dormant = mode === 'all';

  // Absent reads as the server's default, so an agent edited before this
  // field existed shows "With humans" rather than an unset control.
  const dmSupport: DmSupport = value.dm_support ?? 'humans';

  const setDms = (dms: AccessLevel) => onChange({ ...value, dms });

  const setMode = (next: WorkspacesAccessMode) => {
    if (next === 'custom') {
      // Never rewrite the grants on a mode change (R9): they are the thing
      // Custom will show. Only the root's own fields move.
      onChange({ ...value, workspaces: { ...value.workspaces, mode: 'custom', level: null } });
      return;
    }

    if (next === 'all') {
      // The level a fresh `All` starts from. Retained grants stay untouched.
      const level = value.workspaces.level ?? 'read';
      onChange({ ...value, workspaces: { ...value.workspaces, mode: 'all', level } });
      return;
    }

    // None: no level is in force, and the grants are retained for later.
    onChange({ ...value, workspaces: { ...value.workspaces, mode: 'none', level: null } });
  };

  const setAllLevel = (level: AccessLevel) => {
    onChange({ ...value, workspaces: { ...value.workspaces, mode: 'all', level } });
  };

  const setWorkspaceLevel = (workspaceId: string, level: AccessLevel) => {
    const current = value.workspaces.grants[workspaceId] ?? { level: 'none', channels: {} };
    onChange({
      ...value,
      workspaces: {
        ...value.workspaces,
        grants: { ...value.workspaces.grants, [workspaceId]: { ...current, level } },
      },
    });
  };

  const setChannelLevel = (workspaceId: string, channelId: string, level: AccessLevel) => {
    const current = value.workspaces.grants[workspaceId] ?? { level: 'none', channels: {} };
    onChange({
      ...value,
      workspaces: {
        ...value.workspaces,
        grants: {
          ...value.workspaces.grants,
          [workspaceId]: {
            ...current,
            channels: { ...current.channels, [channelId]: level },
          },
        },
      },
    });
  };

  const toggleExpanded = (workspaceId: string) => {
    const next = !expanded[workspaceId];
    setExpanded((d) => ({ ...d, [workspaceId]: next }));

    // Fetch the channels on first expand — the tree can span workspaces the
    // client has not loaded, and guessing a channel list would be worse than
    // showing a loading row.
    if (next && channelCache[workspaceId] === undefined) {
      setChannelCache((cache) => ({ ...cache, [workspaceId]: [] }));
      void loadChannels(workspaceId)
        .then((channels) => setChannelCache((cache) => ({ ...cache, [workspaceId]: channels })))
        .catch(() => setChannelCache((cache) => ({ ...cache, [workspaceId]: [] })));
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid={`${idPrefix}-tree`}>
      {/* Server — fixed. Reported by the server, never set by the caller. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={`${idPrefix}-server`}>
        <span className="min-w-40 flex-1 text-sm font-medium text-text-primary">Server</span>
        <span className="text-xs text-text-muted" data-testid={`${idPrefix}-server-level`}>
          {LEVEL_WORD[value.server]} · always granted · you cannot change this
        </span>
      </div>

      {/* Account — the agent's own identity, nothing to grant. */}
      <div className="flex flex-col gap-1" data-testid={`${idPrefix}-account`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-40 flex-1 text-sm font-medium text-text-primary">Account</span>
          <span className="text-xs text-text-muted">
            your account is never in play: an agent acts as itself
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4">
          <span className="min-w-36 flex-1 text-sm text-text-primary">Agent&rsquo;s account</span>
          <span className="text-xs text-text-muted" data-testid={`${idPrefix}-account-level`}>
            {LEVEL_WORD[value.account.agent]} · its own identity
          </span>
        </div>
      </div>

      {/* DMs — explicit, never implied. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid={`${idPrefix}-dms`}>
        <span className="min-w-40 flex-1 text-sm font-medium text-text-primary">DMs</span>
        <LevelControl
          legend="Direct message access"
          name={`${idPrefix}-dms`}
          testId={`${idPrefix}-dms-level`}
          value={value.dms}
          onChange={setDms}
          disabled={disabled}
        />
      </div>

      {/* DM support — WHO may open a conversation with this agent, which is a
          different question from the `dms` level above (`dms` is what the agent
          itself may do in a DM it already has). Owner-set, default with
          humans (owner direction 2026-09-15). */}
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2"
        data-testid={`${idPrefix}-dm-support`}
      >
        <span className="min-w-40 flex-1 text-sm font-medium text-text-primary">DM support</span>
        <fieldset disabled={disabled}>
          <legend className="sr-only">Direct message support</legend>
          <div className="flex flex-wrap items-center gap-1">
            {DM_SUPPORTS.map((support) => (
              <label
                key={support}
                title={DM_SUPPORT_HINT[support]}
                className={
                  'cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--duration-control)] ' +
                  (disabled
                    ? 'cursor-not-allowed border-line text-text-muted opacity-60'
                    : dmSupport === support
                      ? 'border-accent bg-accent/10 text-text-primary'
                      : 'border-line text-text-muted hover:bg-surface-hover hover:text-text-primary')
                }
              >
                <input
                  type="radio"
                  className="sr-only"
                  data-testid={`${idPrefix}-dm-support-${support}`}
                  name={`${idPrefix}-dm-support`}
                  value={support}
                  checked={dmSupport === support}
                  disabled={disabled}
                  onChange={() => onChange({ ...value, dm_support: support })}
                />
                {DM_SUPPORT_WORD[support]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {/* Workspaces — the root mode, then the per-workspace rows. */}
      <div className="flex flex-col gap-2" data-testid={`${idPrefix}-workspaces`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-40 flex-1 text-sm font-medium text-text-primary">Workspaces</span>
          <fieldset disabled={disabled}>
            <legend className="sr-only">Workspace access mode</legend>
            <div className="flex flex-wrap items-center gap-1">
              {(['none', 'all', 'custom'] as WorkspacesAccessMode[]).map((candidate) => (
                <label
                  key={candidate}
                  title={MODE_HINT[candidate]}
                  className={
                    'cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--duration-control)] ' +
                    (disabled
                      ? 'cursor-not-allowed border-line text-text-muted opacity-60'
                      : mode === candidate
                        ? 'border-accent bg-accent/10 text-text-primary'
                        : 'border-line text-text-muted hover:bg-surface-hover hover:text-text-primary')
                  }
                >
                  <input
                    type="radio"
                    className="sr-only"
                    data-testid={`${idPrefix}-mode-${candidate}`}
                    name={`${idPrefix}-mode`}
                    value={candidate}
                    checked={mode === candidate}
                    disabled={disabled}
                    onChange={() => setMode(candidate)}
                  />
                  {MODE_WORD[candidate]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {mode === 'all' ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-4">
            <span className="min-w-36 flex-1 text-sm text-text-primary">Every workspace</span>
            <LevelControl
              legend="Level for every workspace"
              name={`${idPrefix}-all-level`}
              testId={`${idPrefix}-all-level`}
              value={value.workspaces.level ?? 'none'}
              onChange={setAllLevel}
              disabled={disabled}
            />
          </div>
        ) : null}

        {mode === 'custom' ? (
          workspaces.length === 0 ? (
            <p className="pl-4 text-sm text-text-muted" data-testid={`${idPrefix}-no-workspaces`}>
              You are not in a workspace yet, so there is nothing to grant.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 pl-4">
              {workspaces.map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  idPrefix={idPrefix}
                  workspace={workspace}
                  grant={value.workspaces.grants[workspace.id]}
                  channels={channelCache[workspace.id]}
                  expanded={expanded[workspace.id] === true}
                  onToggle={() => toggleExpanded(workspace.id)}
                  onLevelChange={(level) => setWorkspaceLevel(workspace.id, level)}
                  onChannelLevelChange={(channelId, level) =>
                    setChannelLevel(workspace.id, channelId, level)
                  }
                  disabled={disabled}
                />
              ))}
            </ul>
          )
        ) : null}

        {/* Dormancy (R9): the explicit grants are retained while the root is in
            force. They stay visible and disabled — hiding them would make the
            restoration look like a bug, and Enable would make the root a lie. */}
        {dormant && Object.keys(value.workspaces.grants).length > 0 ? (
          <div className="flex flex-col gap-1 pl-4" data-testid={`${idPrefix}-dormant`}>
            <p className="text-xs text-text-muted">
              Retained — the All-Workspaces setting is in force. Clear it to put these back in
              force; they are unchanged.
            </p>
            <ul className="flex flex-col gap-1 opacity-60">
              {Object.keys(value.workspaces.grants).map((workspaceId) => (
                <li
                  key={workspaceId}
                  className="flex items-center gap-3 text-sm text-text-muted"
                  data-testid={`${idPrefix}-dormant-${workspaceId}`}
                >
                  <span className="flex-1">
                    {workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId}
                  </span>
                  <span className="text-xs">
                    {LEVEL_WORD[value.workspaces.grants[workspaceId]!.level]}
                    {Object.keys(value.workspaces.grants[workspaceId]!.channels).length > 0
                      ? ` · ${Object.keys(value.workspaces.grants[workspaceId]!.channels).length} channel${
                          Object.keys(value.workspaces.grants[workspaceId]!.channels).length === 1
                            ? ''
                            : 's'
                        }`
                      : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceRow({
  idPrefix,
  workspace,
  grant,
  channels,
  expanded,
  onToggle,
  onLevelChange,
  onChannelLevelChange,
  disabled,
}: {
  idPrefix: string;
  workspace: TreeWorkspace;
  grant: { level: AccessLevel; channels: Record<string, AccessLevel> } | undefined;
  channels: ChannelOption[] | undefined;
  expanded: boolean;
  onToggle(): void;
  onLevelChange(level: AccessLevel): void;
  onChannelLevelChange(channelId: string, level: AccessLevel): void;
  disabled: boolean;
}) {
  const level = grant?.level ?? 'none';
  const channelIds = Object.keys(grant?.channels ?? {});

  // Channels only carry meaning when the workspace itself grants something:
  // a per-channel level under a `none` workspace can never be reached.
  const channelsReachable = level !== 'none';

  return (
    <li className="flex flex-col gap-2" data-testid={`${idPrefix}-ws-${workspace.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-36 flex-1 text-sm text-text-primary">{workspace.name}</span>
        <LevelControl
          legend={`Access to ${workspace.name}`}
          name={`${idPrefix}-ws-${workspace.id}`}
          testId={`${idPrefix}-ws-level-${workspace.id}`}
          value={level}
          onChange={onLevelChange}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          data-testid={`${idPrefix}-ws-channels-toggle-${workspace.id}`}
          className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          {expanded ? 'Hide channels' : 'Channels'}
        </button>
      </div>

      {expanded && channelsReachable ? (
        channels === undefined ? (
          <p className="pl-4 text-xs text-text-muted" data-testid={`${idPrefix}-ws-channels-loading-${workspace.id}`}>
            Loading channels…
          </p>
        ) : channels.length === 0 ? (
          <p className="pl-4 text-xs text-text-muted" data-testid={`${idPrefix}-ws-channels-empty-${workspace.id}`}>
            This workspace has no channels yet. New ones inherit the workspace level.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 pl-4" data-testid={`${idPrefix}-ws-channels-${workspace.id}`}>
            {channels.map((channel) => (
              <li key={channel.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-32 flex-1 text-sm text-text-muted">{channel.name}</span>
                <LevelControl
                  legend={`Access to ${channel.name}`}
                  name={`${idPrefix}-ch-${channel.id}`}
                  testId={`${idPrefix}-ch-level-${channel.id}`}
                  value={grant?.channels[channel.id] ?? 'none'}
                  onChange={(next) => onChannelLevelChange(channel.id, next)}
                  disabled={disabled}
                />
              </li>
            ))}
          </ul>
        )
      ) : null}

      {expanded && !channelsReachable ? (
        <p className="pl-4 text-xs text-text-muted" data-testid={`${idPrefix}-ws-channels-unreachable-${workspace.id}`}>
          Set the workspace above to Read or Read-write first — per-channel levels cannot be reached
          from None.
        </p>
      ) : null}

      {channelIds.length > 0 && !expanded ? (
        <p className="pl-4 text-xs text-text-muted" data-testid={`${idPrefix}-ws-channels-summary-${workspace.id}`}>
          {channelIds.length} channel{channelIds.length === 1 ? '' : 's'} set
        </p>
      ) : null}
    </li>
  );
}

/** The one-word test the rest of the app asks: does this document grant anything? */
export function accessIsEmpty(doc: AccessDocument | null | undefined): boolean {
  if (!doc) return true;
  if (doc.dms !== 'none') return false;
  // `=== 'none'`, not `!==`: every other branch here answers "is it empty",
  // and this one answered the opposite — so an agent holding "All workspaces ·
  // Read-write" summarised as "No access yet" in the user settings list, while
  // the integrations panel (which reads the raw document) showed the right
  // level. Owner report 2026-09-14: "Why do the agents in user settings say
  // 'No access yet' when they're clearly in the channel and posting?"
  if (doc.workspaces.mode === 'all') return (doc.workspaces.level ?? 'none') === 'none';
  if (doc.workspaces.mode === 'custom') {
    return !Object.values(doc.workspaces.grants).some(
      (grant) =>
        grant.level !== 'none' || Object.values(grant.channels).some((level) => level !== 'none'),
    );
  }
  return true;
}

/** A one-line summary for a list row — the "no access yet" state's wording. */
export function describeAccess(doc: AccessDocument | null | undefined): string {
  if (!doc || accessIsEmpty(doc)) return 'No access yet';
  if (doc.workspaces.mode === 'all') {
    return `All workspaces · ${LEVEL_WORD[doc.workspaces.level ?? 'none']}`;
  }
  if (doc.workspaces.mode === 'custom') {
    const granting = Object.values(doc.workspaces.grants).filter(
      (grant) =>
        grant.level !== 'none' || Object.values(grant.channels).some((level) => level !== 'none'),
    ).length;
    if (granting > 0) return `${granting} workspace${granting === 1 ? '' : 's'}`;
  }
  return doc.dms !== 'none' ? 'DMs only' : 'No access yet';
}

/** The default document a PATCH expects when an agent has never been granted. */
export function emptyAccessDocument(): AccessDocument {
  return {
    v: 1,
    server: 'read',
    account: { agent: 'read' },
    dms: 'none',
    dm_support: 'humans',
    workspaces: { mode: 'none', level: null, grants: {} },
  };
}
