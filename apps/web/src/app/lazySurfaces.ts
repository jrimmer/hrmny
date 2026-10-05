/**
 * @cytale/web — the shell's secondary surfaces, loaded on demand (lane D #7).
 *
 * The authenticated shell chunk statically imported every surface the app can
 * show — settings (seven sections, the agents access tree, the SSH key
 * manager), server settings, workspace settings, the call panel and call logs,
 * the people directory, the omnisearch palette, the thread dialogs — so the
 * first paint of a conversation waited for all of them to download and parse.
 * None of them is on the boot path: each opens behind a click (or a tab the
 * member chooses).
 *
 * Each surface here is a `React.lazy` over its OWN module path, never a
 * feature barrel: a barrel re-exports the surface alongside the hooks the
 * shell needs eagerly, and one static import of the barrel pulls the whole
 * surface back into the shell chunk. The composer (Lexical) and the message
 * list (virtuoso) stay eager — they ARE the boot path.
 *
 * `prefetchSecondarySurfaces` warms the chunks once the shell is idle, so the
 * first open of a surface rarely waits on the network at all.
 */

import { lazy, type ComponentType } from 'react';

/** `lazy` over a named export (the surfaces export by name, not default). */
function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): ComponentType<M[K] extends ComponentType<infer P> ? P : never> {
  return lazy(async () => {
    const mod = await load();
    return { default: mod[name] as unknown as ComponentType<unknown> };
  }) as unknown as ComponentType<M[K] extends ComponentType<infer P> ? P : never>;
}

const loaders = {
  omnisearch: () => import('../features/search/OmnisearchDialog.js'),
  callPanel: () => import('../features/calls/CallPanel.js'),
  callLog: () => import('../features/calls/log/CallLogStandalone.js'),
  allCalls: () => import('../features/calls/log/AllCallsList.js'),
  people: () => import('../features/directory/PeopleDirectory.js'),
  profile: () => import('../features/directory/ProfileCard.js'),
  threadsDialog: () => import('../features/threads/ThreadsListDialog.js'),
  threadsPanel: () => import('../features/threads/ThreadsListPanel.js'),
  account: () => import('../features/settings/AccountSection.js'),
  agents: () => import('../features/settings/AgentsSection.js'),
  appearance: () => import('../features/settings/AppearanceSection.js'),
  notifications: () => import('../features/settings/NotificationsSection.js'),
  emoji: () => import('../features/settings/ReactionEmojiSection.js'),
  ssh: () => import('../features/settings/SshSection.js'),
  webhooks: () => import('../features/settings/WebhooksSection.js'),
  serverSettings: () => import('../features/serversettings/ServerSettingsPage.js'),
  workspaceOverview: () => import('../features/wsettings/WorkspaceOverview.js'),
  releaseNotes: () => import('../features/releasenotes/ReleaseNotesPane.js'),
};

export const OmnisearchDialog = lazyNamed(loaders.omnisearch, 'OmnisearchDialog');
export const CallPanelSurface = lazyNamed(loaders.callPanel, 'CallPanelSurface');
export const CallLogStandalone = lazyNamed(loaders.callLog, 'CallLogStandalone');
export const AllCallsList = lazyNamed(loaders.allCalls, 'AllCallsList');
export const PeopleDirectory = lazyNamed(loaders.people, 'PeopleDirectory');
export const ProfileCard = lazyNamed(loaders.profile, 'ProfileCard');
export const ThreadsListDialog = lazyNamed(loaders.threadsDialog, 'ThreadsListDialog');
export const ThreadsListPanel = lazyNamed(loaders.threadsPanel, 'ThreadsListPanel');
export const AccountSection = lazyNamed(loaders.account, 'AccountSection');
export const AgentsSection = lazyNamed(loaders.agents, 'AgentsSection');
export const AppearanceSection = lazyNamed(loaders.appearance, 'AppearanceSection');
export const NotificationsSection = lazyNamed(loaders.notifications, 'NotificationsSection');
export const ReactionEmojiSection = lazyNamed(loaders.emoji, 'ReactionEmojiSection');
export const SshSection = lazyNamed(loaders.ssh, 'SshSection');
export const WebhooksSection = lazyNamed(loaders.webhooks, 'WebhooksSection');
export const ServerSettingsPage = lazyNamed(loaders.serverSettings, 'ServerSettingsPage');
export const WorkspaceOverview = lazyNamed(loaders.workspaceOverview, 'WorkspaceOverview');
export const ReleaseNotesPane = lazyNamed(loaders.releaseNotes, 'ReleaseNotesPane');

let prefetched = false;

/**
 * Warm every secondary chunk once the shell is idle (lane D #7): the member's
 * first click on settings, a call log or the directory then finds the code
 * already parsed. `first` names chunks the CURRENT layout will render soon
 * (the desktop member rail opens on the people directory) — fetched at once.
 */
export function prefetchSecondarySurfaces(first: readonly (keyof typeof loaders)[] = []): void {
  for (const key of first) void loaders[key]().catch(() => undefined);
  if (prefetched) return;
  prefetched = true;
  const run = () => {
    for (const load of Object.values(loaders)) void load().catch(() => undefined);
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof idle === 'function') idle(run, { timeout: 5_000 });
  else setTimeout(run, 2_000);
}
