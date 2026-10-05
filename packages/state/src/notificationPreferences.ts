/**
 * @cytale/state — the member's notification preferences, as ONE shared
 * source of truth (notification controls, 2026-09-27).
 *
 * Before this module the levels lived in three places that never talked: the
 * Settings → Notifications surface fetched its own copy on open, the ding
 * coordinator held a module-level override cache nobody ever filled, and no
 * other surface knew a level existed. A control in the channel header that
 * wrote a level would then have left the settings tree, the sidebar and the
 * ding all describing a different world.
 *
 * So the preferences live IN the store (`StateState.notificationPrefs`),
 * beside the unread slices they shape, and every surface — header control,
 * channel and workspace menus, sidebar rows, the thread panel, the settings
 * overview, the ding, and the live mention accrual in `reconcile.ts` — reads
 * that one slice through the helpers below. A write is optimistic: the slice
 * changes first (so every surface moves together), then the server hears, and
 * a refusal rolls the ONE slice back — no surface can be left holding the
 * value that failed.
 *
 * ## The walk
 *
 * `resolveNotificationLevel` is the client's copy of the server's inheritance
 * walk (`Cytale.Notifications.Resolver`): thread → channel → workspace →
 * account, most specific first, an absent layer SKIPPED rather than
 * terminating, `"mentions"` when nothing is set. Duplicated deliberately — the
 * alternative (rendering only what the server last resolved) needs a round
 * trip per row and is wrong between a write and its re-read. The order and the
 * default are pinned by tests on both sides.
 *
 * ## The broadcast switch
 *
 * "Mentions only" INCLUDES `@everyone`/`@here`, per workspace, unless the
 * member switched on "Suppress @everyone and @here" there. The switch rides
 * the same slice (`suppressBroadcasts`) because the live mention accrual needs
 * it on every message: a broadcast counts as a mention exactly when the
 * server would have written the member an inbox row for it.
 */

import { mentionsEveryone, mentionsHere, mentionsPlainUser } from '@cytale/domain';

import { setStateIfChanged, type StateState, type StateStore } from './store.js';

/** One stored or inherited notification level. */
export type NotificationLevel = 'all' | 'mentions' | 'mute';

/** The layers a level can be stored at. */
export type NotificationScope = 'account' | 'workspace' | 'channel' | 'thread';

/** The layer that decided a resolved level (participation = R11's sweep). */
export type NotificationDecidedBy = NotificationScope | 'participation';

/** What an unconfigured member receives — the server's `@default_level`. */
export const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = 'mentions';

/**
 * The header control's cycle, in order: bell (all) → @ (mentions only) →
 * bell-off (nothing) → bell. One list, so the control, its label ("click for
 * …") and its tests cannot disagree about what comes next.
 */
export const NOTIFICATION_LEVEL_CYCLE: readonly NotificationLevel[] = ['all', 'mentions', 'mute'];

/** The level a click moves to from `level`. */
export function nextNotificationLevel(level: NotificationLevel): NotificationLevel {
  const at = NOTIFICATION_LEVEL_CYCLE.indexOf(level);
  return NOTIFICATION_LEVEL_CYCLE[(at + 1) % NOTIFICATION_LEVEL_CYCLE.length] as NotificationLevel;
}

/** The account layer's entity id — a singleton by convention (the server's `(0, 0)`). */
export const ACCOUNT_ENTITY_ID = '0';

/** The key an override map uses for one layer. */
export function notificationOverrideKey(scope: string, entityId: string): string {
  return `${scope}:${entityId}`;
}

/** The slice every surface reads. */
export interface NotificationPrefsState {
  /** Stored overrides, keyed `scope:entityId`. Absent = inherit. */
  overrides: Record<string, NotificationLevel>;
  /** Workspaces whose broadcasts the member suppresses. Absent = broadcasts count. */
  suppressBroadcasts: Record<string, true>;
  /**
   * `idle` before the first hydrate, `ready` after one landed, `error` when
   * the hydrate failed (surfaces render the default rather than a spinner:
   * the default IS the server's answer for a member with no rows).
   */
  status: 'idle' | 'loading' | 'ready' | 'error';
}

export function emptyNotificationPrefs(): NotificationPrefsState {
  return { overrides: {}, suppressBroadcasts: {}, status: 'idle' };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export interface ResolveNotificationInput {
  /** Stored overrides, keyed `scope:entityId`. */
  overrides: Record<string, NotificationLevel>;
  accountEntityId?: string;
  workspaceId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  /** True when the member has posted in this channel or thread (R11). */
  participated?: boolean;
}

export interface ResolvedNotificationLevel {
  /** The effective level, after the walk. */
  level: NotificationLevel;
  /** The layer that decided it. */
  decidedBy: NotificationDecidedBy;
  /**
   * True when SOME layer was set. Note this is not "this entity is
   * overridden" — `explicitAt` answers that for a named layer.
   */
  overridden: boolean;
}

/**
 * Resolve a level through the same walk the server runs: thread → channel →
 * workspace → account, most specific first, an absent layer skipped.
 */
export function resolveNotificationLevel(input: ResolveNotificationInput): ResolvedNotificationLevel {
  const accountEntityId = input.accountEntityId ?? ACCOUNT_ENTITY_ID;

  const candidates: Array<[NotificationScope, string | null | undefined]> = [
    ['thread', input.threadId],
    ['channel', input.channelId],
    ['workspace', input.workspaceId],
  ];

  for (const [scope, entityId] of candidates) {
    if (entityId == null) continue;
    const stored = input.overrides[notificationOverrideKey(scope, entityId)];
    if (stored !== undefined) {
      // A mute is lifted by participation, exactly as the server does it: a
      // member who posted where the event happened hears about a reply there.
      if (stored === 'mute' && input.participated) {
        return { level: 'all', decidedBy: 'participation', overridden: true };
      }
      return { level: stored, decidedBy: scope, overridden: true };
    }
  }

  const account = input.overrides[notificationOverrideKey('account', accountEntityId)];
  if (account !== undefined) {
    return { level: account, decidedBy: 'account', overridden: true };
  }

  return { level: DEFAULT_NOTIFICATION_LEVEL, decidedBy: 'account', overridden: false };
}

/** What a control needs to render one target's level. */
export interface NotificationTarget {
  /** The layer the control WRITES — the most specific one it names. */
  scope: NotificationScope;
  /** The entity at that layer (`ACCOUNT_ENTITY_ID` for the account). */
  entityId: string;
  /** The ancestors the walk falls back through. */
  workspaceId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
}

export interface NotificationTargetView extends ResolvedNotificationLevel {
  /** True when the TARGET's own layer holds a row (the control is not inheriting). */
  explicit: boolean;
  /**
   * When inheriting: the level the target would have with its own row
   * cleared — which is exactly `level` then, so this is only interesting
   * WHILE explicit: what "Use … default" would land on.
   */
  inheritedLevel: NotificationLevel;
  /** The layer `inheritedLevel` comes from. */
  inheritedFrom: NotificationDecidedBy;
}

/**
 * Resolve a control's target: its effective level, whether it holds its own
 * row, and what it would inherit without one. One call gives a header button
 * everything its icon, dimming, tooltip and reset entry need.
 */
export function resolveNotificationTarget(
  prefs: NotificationPrefsState,
  target: NotificationTarget,
): NotificationTargetView {
  const chain = {
    overrides: prefs.overrides,
    workspaceId: target.workspaceId ?? null,
    channelId: target.channelId ?? null,
    threadId: target.threadId ?? null,
  };
  const resolved = resolveNotificationLevel(chain);
  const explicit = prefs.overrides[notificationOverrideKey(target.scope, target.entityId)] !== undefined;

  // The walk with the target's own layer removed: what "Use … default" lands on.
  const parent =
    target.scope === 'thread'
      ? resolveNotificationLevel({ ...chain, threadId: null })
      : target.scope === 'channel'
        ? resolveNotificationLevel({ ...chain, threadId: null, channelId: null })
        : target.scope === 'workspace'
          ? resolveNotificationLevel({ overrides: prefs.overrides })
          : { level: DEFAULT_NOTIFICATION_LEVEL, decidedBy: 'account' as const, overridden: false };

  return { ...resolved, explicit, inheritedLevel: parent.level, inheritedFrom: parent.decidedBy };
}

// ---------------------------------------------------------------------------
// Words — one vocabulary for every client (web header/menus/settings, the
// phone sheet, the native app), so a level is never named two ways
// ---------------------------------------------------------------------------

/** A level's name as every surface says it. */
export const NOTIFICATION_LEVEL_LABEL: Record<NotificationLevel, string> = {
  all: 'All messages',
  mentions: 'Mentions only',
  mute: 'Nothing',
};

/** A layer's name inside "(workspace default)"-style provenance. */
export const NOTIFICATION_LAYER_LABEL: Record<NotificationDecidedBy, string> = {
  account: 'account default',
  workspace: 'workspace default',
  channel: 'channel default',
  thread: 'thread setting',
  participation: 'you took part',
};

/**
 * What "Use … default" says for a target — the layer it falls back to when
 * its own row is cleared. A DM has no workspace above it, so its default is
 * the account's ("Use default"); a thread's is its channel's.
 */
export function notificationResetLabel(target: Pick<NotificationTarget, 'scope' | 'workspaceId'>): string {
  if (target.scope === 'thread') return 'Use channel default';
  if (target.scope === 'workspace') return 'Use account default';
  if (target.scope === 'channel' && target.workspaceId == null) return 'Use default';
  return 'Use workspace default';
}

/**
 * The header control's accessible name and tooltip: the CURRENT state (with
 * its provenance while inherited) and what a click does next — one string,
 * so the tooltip and the screen reader never disagree.
 *
 *   "Notifications: Mentions only (workspace default) — click for Nothing"
 */
export function notificationControlLabel(view: NotificationTargetView, verb = 'click'): string {
  const next = NOTIFICATION_LEVEL_LABEL[nextNotificationLevel(view.level)];
  const current = NOTIFICATION_LEVEL_LABEL[view.level];
  const provenance = view.explicit ? '' : ` (${NOTIFICATION_LAYER_LABEL[view.decidedBy]})`;
  return `Notifications: ${current}${provenance} — ${verb} for ${next}`;
}

/** Whether the member suppresses broadcasts in this workspace. */
export function isBroadcastSuppressed(prefs: NotificationPrefsState, workspaceId: string | null | undefined): boolean {
  return workspaceId != null && prefs.suppressBroadcasts[workspaceId] === true;
}

/**
 * Whether a message ADDRESSES the member for the mention badge — the client's
 * twin of the server's inbox recorder (`Cytale.Inbox.record_mentions/1`), so a
 * live count and the count a reload hydrates agree:
 *
 *   * a direct plain-form mention (`<@id>`, the form the server stores), or
 *   * `@everyone` / `@here` in a WORKSPACE channel (the server records no
 *     broadcast rows for DMs, which are addressed as a whole anyway) whose
 *     workspace the member has not suppressed.
 *
 * Never for the member's own message, and never for oversized content (the
 * accrual's historical guard against scanning a huge body on the hot path).
 */
export function messageAddressesMe(
  state: Pick<StateState, 'currentUser' | 'channels' | 'notificationPrefs'>,
  message: { channel_id: string; author_id: string; content: string },
): boolean {
  const me = state.currentUser;
  if (me === null || message.author_id === me.id) return false;
  const content = message.content;
  if (typeof content !== 'string' || content.length === 0 || content.length >= 8192) return false;
  if (mentionsPlainUser(content, me.id)) return true;
  if (!mentionsEveryone(content) && !mentionsHere(content)) return false;
  const workspaceId = state.channels[message.channel_id]?.workspace_id ?? null;
  if (workspaceId === null) return false;
  return !isBroadcastSuppressed(state.notificationPrefs, workspaceId);
}

// ---------------------------------------------------------------------------
// The writes — optimistic, with a per-key rollback
// ---------------------------------------------------------------------------

/** The four REST calls the writes need (the api client's own methods). */
export interface NotificationPrefsApi {
  getNotificationPreferences(): Promise<{
    preferences: Array<{ scope: string; entity_id: string; level: NotificationLevel }>;
    suppress_broadcasts: string[];
  }>;
  setNotificationPreference(scope: NotificationScope, level: NotificationLevel, entityId?: string): Promise<void>;
  clearNotificationPreference(scope: NotificationScope, entityId: string): Promise<void>;
  setBroadcastSuppression(workspaceId: string, suppress: boolean): Promise<void>;
}

/**
 * Write generations per store and key. A rollback only restores when ITS
 * write is still the latest for that key: two quick clicks (all → mentions →
 * mute) where the first fails must not snap the control back over the second.
 */
const generations = new WeakMap<StateStore, Map<string, number>>();

function bump(store: StateStore, key: string): number {
  let byKey = generations.get(store);
  if (!byKey) {
    byKey = new Map();
    generations.set(store, byKey);
  }
  const next = (byKey.get(key) ?? 0) + 1;
  byKey.set(key, next);
  return next;
}

function isLatest(store: StateStore, key: string, generation: number): boolean {
  return generations.get(store)?.get(key) === generation;
}

function patchPrefs(store: StateStore, update: (prefs: NotificationPrefsState) => NotificationPrefsState): void {
  setStateIfChanged(store, (s) => {
    const next = update(s.notificationPrefs);
    return next === s.notificationPrefs ? {} : { notificationPrefs: next };
  });
}

function withOverride(
  prefs: NotificationPrefsState,
  key: string,
  level: NotificationLevel | undefined,
): NotificationPrefsState {
  if (prefs.overrides[key] === level) return prefs;
  const overrides = { ...prefs.overrides };
  if (level === undefined) delete overrides[key];
  else overrides[key] = level;
  return { ...prefs, overrides };
}

function withSuppression(prefs: NotificationPrefsState, workspaceId: string, on: boolean): NotificationPrefsState {
  if ((prefs.suppressBroadcasts[workspaceId] === true) === on) return prefs;
  const suppressBroadcasts = { ...prefs.suppressBroadcasts };
  if (on) suppressBroadcasts[workspaceId] = true;
  else delete suppressBroadcasts[workspaceId];
  return { ...prefs, suppressBroadcasts };
}

/**
 * Load the member's preferences into the store. Called once per session (and
 * whenever a surface wants a fresh read — the Settings overview on open). A
 * failure leaves the slice as it was and marks it `error`; it never clears a
 * value a control already shows.
 */
export async function hydrateNotificationPreferences(store: StateStore, api: NotificationPrefsApi): Promise<void> {
  // Writes that start while the read is in flight win over the read's
  // snapshot: remember the generations at the start, and keep any key that
  // moved since.
  const startGen = new Map(generations.get(store) ?? []);
  patchPrefs(store, (p) => (p.status === 'ready' ? p : { ...p, status: 'loading' }));
  try {
    const set = await api.getNotificationPreferences();
    const overrides: Record<string, NotificationLevel> = {};
    for (const pref of set.preferences) {
      overrides[notificationOverrideKey(pref.scope, pref.entity_id)] = pref.level;
    }
    const suppressBroadcasts: Record<string, true> = {};
    for (const id of set.suppress_broadcasts) suppressBroadcasts[id] = true;

    patchPrefs(store, (current) => {
      const moved = (key: string) => (generations.get(store)?.get(key) ?? 0) !== (startGen.get(key) ?? 0);
      const nextOverrides = { ...overrides };
      const nextSuppress = { ...suppressBroadcasts };
      for (const key of generations.get(store)?.keys() ?? []) {
        if (!moved(key)) continue;
        if (key.startsWith('suppress:')) {
          const ws = key.slice('suppress:'.length);
          if (current.suppressBroadcasts[ws]) nextSuppress[ws] = true;
          else delete nextSuppress[ws];
        } else if (current.overrides[key] !== undefined) {
          nextOverrides[key] = current.overrides[key] as NotificationLevel;
        } else {
          delete nextOverrides[key];
        }
      }
      return { overrides: nextOverrides, suppressBroadcasts: nextSuppress, status: 'ready' };
    });
  } catch {
    patchPrefs(store, (p) => ({ ...p, status: p.status === 'ready' ? 'ready' : 'error' }));
  }
}

/**
 * Set one layer's level, optimistically. Rejects (after rolling back) when the
 * server refuses, so the calling control can say so.
 */
export async function setNotificationLevel(
  store: StateStore,
  api: NotificationPrefsApi,
  scope: NotificationScope,
  entityId: string,
  level: NotificationLevel,
): Promise<void> {
  const key = notificationOverrideKey(scope, entityId);
  const previous = store.getState().notificationPrefs.overrides[key];
  const generation = bump(store, key);
  patchPrefs(store, (p) => withOverride(p, key, level));
  try {
    await (scope === 'account'
      ? api.setNotificationPreference('account', level)
      : api.setNotificationPreference(scope, level, entityId));
  } catch (error) {
    if (isLatest(store, key, generation)) patchPrefs(store, (p) => withOverride(p, key, previous));
    throw error;
  }
}

/**
 * Clear one layer's row, returning the entity to inherit ("Use … default").
 * Optimistic with the same rollback contract as `setNotificationLevel`.
 */
export async function clearNotificationLevel(
  store: StateStore,
  api: NotificationPrefsApi,
  scope: NotificationScope,
  entityId: string,
): Promise<void> {
  const key = notificationOverrideKey(scope, entityId);
  const previous = store.getState().notificationPrefs.overrides[key];
  if (previous === undefined) return; // already inheriting: nothing to say to the server
  const generation = bump(store, key);
  patchPrefs(store, (p) => withOverride(p, key, undefined));
  try {
    await api.clearNotificationPreference(scope, entityId);
  } catch (error) {
    if (isLatest(store, key, generation)) patchPrefs(store, (p) => withOverride(p, key, previous));
    throw error;
  }
}

/** Turn a workspace's "Suppress @everyone and @here" switch on or off, optimistically. */
export async function setBroadcastSuppressed(
  store: StateStore,
  api: NotificationPrefsApi,
  workspaceId: string,
  suppress: boolean,
): Promise<void> {
  const key = `suppress:${workspaceId}`;
  const previous = isBroadcastSuppressed(store.getState().notificationPrefs, workspaceId);
  const generation = bump(store, key);
  patchPrefs(store, (p) => withSuppression(p, workspaceId, suppress));
  try {
    await api.setBroadcastSuppression(workspaceId, suppress);
  } catch (error) {
    if (isLatest(store, key, generation)) patchPrefs(store, (p) => withSuppression(p, workspaceId, previous));
    throw error;
  }
}
