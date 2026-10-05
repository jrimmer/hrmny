/**
 * @cytale/web — the `/m/<token>` page path (#118, option B).
 *
 * A copied permalink is an opaque PATH now (`https://<origin>/m/<token>`), and
 * this module is the decode at the edge: the token is resolved over
 * `GET /api/v1/permalinks/{token}`, the pair it names is turned back into the
 * ordinary `#/…channel/…message/…` route, and everything downstream is #114's
 * landing, unchanged — the same hash parse, the same navigation effects, the
 * same scroll/flash/thread behavior. One decode at the edge; one route grammar
 * inside.
 *
 * ## Why the server cannot do this part
 *
 * The document request for `/m/<token>` is served by the SPA fallback with the
 * content-free card, for everyone: web access tokens are memory-only, so a
 * signed-in reader's document request is indistinguishable from a stranger's
 * (its authenticated reads are separate XHRs). So the shell always loads and
 * the APP resolves the token — which is also why the failure below is a real
 * state rather than a redirect: a signed-out visitor signs in and the token is
 * still in the path, waiting.
 *
 * ## The URL after landing
 *
 * The address is replaced with the ordinary form (`/#/…`) once the token has
 * been decoded, so the address bar shows the route the app is actually on, and
 * a reload replays nothing (no second mint, no second resolve). The opaque URL
 * stays the thing people copy: it is what was sent to them, and it keeps
 * working however many times it is opened.
 */

import { useEffect, useState } from 'react';

import { buildPermalinkPath } from '@cytale/domain';
import { defaultStore, type StateStore } from '@cytale/state';

import { api } from '../auth/session.js';
import { permalinkTokenFromPath } from './messagePermalink.js';

/** What the resolve call returns: the pair the token names. */
export interface ResolvedPermalinkTarget {
  channel_id: string;
  message_id: string;
}

/** The resolve call, as an injectable seam (tests never hit the network). */
export type PermalinkResolver = (token: string) => Promise<ResolvedPermalinkTarget>;

/** The production resolver: the shared session api-client. */
const defaultResolver: PermalinkResolver = (token) => api.resolvePermalink(token);

/** The one thing a reader is told when a link does not resolve. */
export const PERMALINK_LANDING_FAILED =
  "That link doesn't work — the message may be gone, or you may not have access to it.";

export interface PathPermalinkOptions {
  /** Hash-router navigation (`useHashRoute().navigate`). */
  navigate: (to: string) => void;
  /** Resolve override (tests); defaults to the session api-client. */
  resolve?: PermalinkResolver;
  /** Store the channel's workspace is read from; defaults to the real one. */
  store?: StateStore;
}

export interface PathPermalinkState {
  /** A token is in the path and its resolution is in flight. */
  pending: boolean;
  /** Set when the token did not resolve — render this, do not swallow it. */
  error: string | null;
}

/**
 * Resolve `/m/<token>` from this page's path, ONCE, and hand the target to the
 * ordinary hash route. A path that is not a permalink does nothing at all.
 */
export function usePathPermalink({
  navigate,
  resolve = defaultResolver,
  store = defaultStore,
}: PathPermalinkOptions): PathPermalinkState {
  // Read once, at mount: this is a boot-time decode of the address the visitor
  // arrived with, not a subscription to the browser's location.
  const token = typeof globalThis.location === 'undefined'
    ? null
    : permalinkTokenFromPath(globalThis.location.pathname);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(token !== null);

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;

    resolve(token)
      .then((target) => {
        if (cancelled) return;
        const channel = store.getState().channels[target.channel_id];
        // The workspace segment is optional in the grammar (a DM has none), and
        // the store is the only thing here that may know it — the token does
        // not carry it, deliberately.
        const path = buildPermalinkPath({
          kind: 'message',
          workspaceId: channel?.workspace_id ?? undefined,
          channelId: target.channel_id,
          messageId: target.message_id,
        });
        if (path === null) {
          setPending(false);
          setError(PERMALINK_LANDING_FAILED);
          return;
        }
        navigate(path);
        // …and replace the page path with the root: the address is the route
        // the app is on now, so a reload is an ordinary #114 permalink load.
        // (`navigate` has already fired the hashchange the router listens for.)
        try {
          globalThis.history?.replaceState?.(null, '', `/#${path}`);
        } catch {
          // A browser that refuses the rewrite keeps the /m/<token> address —
          // which still works. Never a reason to fail the landing.
        }
        setPending(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPending(false);
        setError(PERMALINK_LANDING_FAILED);
      });

    return () => {
      cancelled = true;
    };
    // One decode per token: `navigate`, `resolve` and `store` are stable seams.
  }, [token, resolve, store, navigate]);

  return { pending, error };
}

/**
 * The landing failure, as a surface. One message for every miss on purpose —
 * the server answers the same 404 for an unknown token, a tampered one, and a
 * channel the reader cannot see, and the client must not add a distinction the
 * server deliberately refused to make.
 */
export function PathPermalinkNotice({ state }: { state: PathPermalinkState }) {
  if (state.error === null) return null;
  return (
    <div
      role="alert"
      data-testid="permalink-notice"
      className="fixed left-1/2 top-4 z-50 -translate-x-1/2 max-w-[90vw] rounded-md border border-border bg-surface-emphasized px-4 py-2 text-[14px] text-text-primary shadow-lg"
    >
      {state.error}
    </div>
  );
}
