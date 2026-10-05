/**
 * @cytale/web — Tauri deep-link parsing (U27) and the shell's link feed
 * (#114).
 *
 * The desktop shell registers the `cytale://` scheme (see
 * apps/desktop/src-tauri/capabilities/desktop.json). A deep link like
 * `cytale://workspace/{id}/channel/{id}/message/{id}` is handed to the web
 * app so a permalink (#114), search jump-to-message (U24) and thread deep
 * links (U22) can navigate to the exact message.
 *
 * Anything off the OS can arrive here, so parsing is a BOUNDARY, not a
 * second grammar: this module owns exactly the scheme-level work — the
 * length cap and the case-insensitive scheme match — and hands the rest to
 * the ONE segment grammar in `@cytale/domain` (`parsePermalinkPath`), which
 * the in-app hash route reads with too. Before #114 this module carried one
 * regex for the shape and the route carried another; Copy Link would have
 * been a third writer of an address nobody owned.
 *
 * `subscribeToDeepLinks` is the other half: the shell EMITS each opened URL
 * (see apps/desktop/src-tauri/src/lib.rs) and retains the launch URL for the
 * cold-start case, where the webview was not loaded yet when the OS handed
 * the link over.
 *
 * Pure parse — no side effects, safe in tests.
 */

import { parsePermalinkPath, type PermalinkTarget } from '@cytale/domain';

/**
 * The shell's target shape. Now an alias of the shared grammar's target: the
 * scheme and the in-app path describe the SAME address, so they must not be
 * able to drift into two types.
 */
export type DeepLinkTarget = PermalinkTarget;

/**
 * Longest deep link worth parsing. The longest legitimate link is roughly
 * `cytale://workspace/<20>/channel/<20>/thread/<20>/message/<20>` ≈ 100
 * chars, so this is generous headroom; the cap exists so a multi-megabyte
 * "URL" from the OS cannot be walked, decoded, and captured into state.
 */
const MAX_DEEP_LINK_LENGTH = 2_048;

/**
 * Case-insensitive scheme only (`CYTALE://` is the same scheme per RFC 3986).
 * Everything after it is the shared grammar's business — path segments stay
 * case-sensitive there, and every id is digits.
 */
const SCHEME_RE = /^cytale:\/\//i;

/**
 * Parse a `cytale://` deep-link URL into a structured target, or null when
 * the URL is not a valid Cytale deep link.
 */
export function parseDeepLink(raw: string): DeepLinkTarget | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_DEEP_LINK_LENGTH) return null;

  const m = SCHEME_RE.exec(raw);
  if (!m) return null;

  return parsePermalinkPath(raw.slice(m[0].length));
}

// ---------------------------------------------------------------------------
// The shell's link feed (#114)
// ---------------------------------------------------------------------------

/**
 * The event the Rust shell emits for each opened URL
 * (`apps/desktop/src-tauri/src/lib.rs`, `handle.emit("cytale-deep-link", …)`).
 */
export const DEEP_LINK_EVENT = 'cytale-deep-link';

/**
 * The command that returns — ONCE — the URL the app was LAUNCHED with, and
 * clears it. The cold-start half: on a launch-by-link the OS delivers the URL
 * before the webview exists, so an emitted event has no listener yet and is
 * lost. The shell stashes it instead and hands it over on request.
 */
export const DEEP_LINK_TAKE_PENDING_COMMAND = 'deep_link_take_pending';

/** The Tauri internals this module needs (the `invoke` bridge, U27's seam). */
interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
type UnlistenFn = () => void;

/**
 * Load Tauri's event API lazily.
 *
 * Lazy for the same reason `notifications.ts` is: the package only exists in
 * a shell build's dependency graph in practice, and importing it at module
 * scope would pull Tauri internals into the browser/PWA bundle. Injectable
 * so the subscription is testable without a running shell.
 */
export interface DeepLinkBridge {
  /** `listen` from `@tauri-apps/api/event`. */
  listen(event: string, handler: (event: { payload: unknown }) => void): Promise<UnlistenFn>;
  /** `invoke` from `@tauri-apps/api/core` (or the internals' own bridge). */
  invoke(command: string): Promise<unknown>;
}

async function defaultBridge(): Promise<DeepLinkBridge | null> {
  const internals = (
    globalThis as { window?: { __TAURI_INTERNALS__?: Partial<TauriInternals> } }
  ).window?.__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') return null;
  // Bound, not detached: the injected bridge is called as a method
  // (`tauriTokenStorage.ts` does the same), and it does not promise a `this`.
  const invoke = internals.invoke.bind(internals);

  try {
    const event = (await import('@tauri-apps/api/event')) as {
      listen: DeepLinkBridge['listen'];
    };
    return {
      listen: event.listen,
      invoke: (command) => invoke(command),
    };
  } catch {
    // A shell build without the event binding: nothing can be delivered
    // live, and that is a state rather than an error.
    return null;
  }
}

/**
 * Subscribe to `cytale://` links opened while the shell is running, then
 * deliver the URL the shell was LAUNCHED with (if any). Returns an
 * unsubscribe function (a no-op in a browser, or when the shell is absent).
 *
 * Order matters and is deliberate: the live listener is attached BEFORE the
 * pending launch URL is read, so a link that arrives during the handover can
 * never be dropped between the two steps.
 *
 * Cold start is delivered LAST, after the caller's own mount work — the
 * pending URL can arrive before the app has rendered anything to navigate.
 * Delivery is one-shot: the shell clears its copy when asked, so a reload
 * does not re-open a link the member has already visited.
 */
export async function subscribeToDeepLinks(
  onTarget: (target: DeepLinkTarget, raw: string) => void,
  bridge?: DeepLinkBridge | null,
): Promise<UnlistenFn> {
  const b = bridge === undefined ? await defaultBridge() : bridge;
  if (!b) return () => undefined;

  let unlisten: UnlistenFn = () => undefined;
  try {
    unlisten = await b.listen(DEEP_LINK_EVENT, (event) => {
      if (typeof event.payload !== 'string') return;
      const target = parseDeepLink(event.payload);
      if (target) onTarget(target, event.payload);
    });
  } catch {
    // The listener could not be registered; the pending-URL path below still
    // gives a cold start its link.
  }

  try {
    const pending = await b.invoke(DEEP_LINK_TAKE_PENDING_COMMAND);
    if (typeof pending === 'string') {
      const target = parseDeepLink(pending);
      if (target) onTarget(target, pending);
    }
  } catch {
    // No shell state (browser, or an older shell): nothing was pending.
  }

  return unlisten;
}
