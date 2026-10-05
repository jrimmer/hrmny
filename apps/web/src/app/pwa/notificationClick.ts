/**
 * The in-app address of a notification's target — the app-side twin of the
 * service worker's cytaleTargetPath (a plain importScripts file cannot share
 * modules; keep the two grammars in lockstep, which the tests do by pinning
 * both).
 *
 * Grammar (the permalink builder's): a workspace message is
 * `#/workspace/{ws}/channel/{ch}[/thread/{t}]/message/{id}`; a DM carries no
 * workspace segment.
 */
export interface NotificationTarget {
  workspace_id?: string | null;
  channel_id?: string;
  thread_id?: string | null;
  message_id?: string;
}

export function notificationClickPath(target: NotificationTarget): string | null {
  const ch = target.channel_id;
  const id = target.message_id;
  if (!ch || !id) return null;
  const mid = `${target.thread_id ? `/thread/${target.thread_id}` : ''}/message/${id}`;
  return target.workspace_id
    ? `#/workspace/${target.workspace_id}/channel/${ch}${mid}`
    : `#/channel/${ch}${mid}`;
}
