/**
 * @cytale/web — client-error capture for the SPA (#88).
 *
 * The web app and the Tauri desktop shell share this SPA, so ONE set of
 * capture points covers both: `window.onerror`, `unhandledrejection`, a React
 * error boundary around the app shell, and the gateway client's own socket
 * telemetry. Tauri's Rust-side failures are explicitly out of scope.
 *
 * This module owns only the CAPTURE POINTS and the wiring; every policy
 * decision — redaction, fingerprinting, dedupe, rate caps, the "never throw"
 * guarantee — lives in `@cytale/api-client`'s `ClientErrorReporter`, shared
 * with mobile. The seam sits BESIDE the auth error-classification layer
 * (`features/auth/authErrors.ts`), not inside it: that layer decides what to
 * SHOW a user, this one decides what to the maintainer.
 *
 * Nothing here is a new instrumentation channel. The socket story in
 * particular is `GatewayClient.getTelemetry()`'s existing counters
 * (`malformed_frames_total`, `reconnects_total`, resume gaps, …), polled for
 * deltas — the ticket's "report THOSE, don't add new instrumentation".
 */

import {
  ClientErrorReporter,
  createGatewayTelemetryPoller,
  DEFAULT_GATEWAY_POLL_INTERVAL_MS,
  type ClientErrorPayload,
} from '@cytale/api-client';
import type { GatewayClient } from '@cytale/gateway-client';

import { APP_VERSION } from '../../app/version.js';
import { isTauri } from '../../tauri/index.js';

/** The one thing this module needs from the api client. */
export interface ClientErrorSender {
  reportClientError(payload: ClientErrorPayload): Promise<void>;
}

/** Poll cadence for the gateway telemetry. A socket story is not urgent. */
export const GATEWAY_POLL_INTERVAL_MS = DEFAULT_GATEWAY_POLL_INTERVAL_MS;

// The poller itself lives in `@cytale/api-client` (typed structurally against
// `getTelemetry()`), so mobile runs the SAME one rather than a copy.
export { createGatewayTelemetryPoller, type GatewayTelemetryPoller } from '@cytale/api-client';

/**
 * The production reporter. `send` resolves the api client lazily because the
 * reporter can be reached (and can observe a failure) before the session is
 * built; before `installClientErrorCapture` has run, a report is dropped
 * rather than queued forever.
 */
let apiRef: ClientErrorSender | null = null;

export function setClientErrorSender(sender: ClientErrorSender | null): void {
  apiRef = sender;
}

/** Where the app currently is — a hash route, redacted by the reporter. */
function currentRoute(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location.hash || window.location.pathname;
}

export const clientErrors = new ClientErrorReporter({
  client: isTauri() ? 'desktop' : 'web',
  version: () => APP_VERSION,
  route: currentRoute,
  // Offline reports are HELD (bounded, deduped) and sent on `online`, rather
  // than attempted and dropped: a crash while offline is exactly the report
  // worth keeping. Each is still sent at most once — see the reporter's docs.
  isOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
  send: payload => {
    const api = apiRef;
    if (!api) return Promise.reject(new Error('client error sender not installed'));
    return api.reportClientError(payload);
  },
});

export interface InstallOptions {
  /** The api client that carries the report to the server. */
  api?: ClientErrorSender;
  /** Override the reporter (tests). Defaults to the shared `clientErrors`. */
  reporter?: ClientErrorReporter;
  /** Reads the live gateway client; return null before a session exists. */
  gateway?: () => GatewayClient | null;
  /** Poll cadence override (tests). */
  pollIntervalMs?: number;
  /** `window` by default; injectable so a test need not touch the real one. */
  target?: Window;
}

/**
 * Install every web capture point. Returns an uninstall function, which the
 * suite uses between cases (the app calls it once, at boot, and never
 * uninstalls).
 */
/** window.onerror messages that are browser notices, not client bugs. */
const BENIGN_WINDOW_ERRORS = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;

export function installClientErrorCapture(options: InstallOptions = {}): () => void {
  const reporter = options.reporter ?? clientErrors;
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined);

  if (options.api) apiRef = options.api;

  const teardown: Array<() => void> = [];

  if (target) {
    // An uncaught exception. `capture: false` deliberately: with capture the
    // same listener also receives every resource-load failure (a missing
    // avatar, a blocked font), which is noise, not a client-side bug.
    const onError = (event: ErrorEvent): void => {
      // The browser's ResizeObserver loop notice is not an exception: it is
      // raised when an observer's callback changes layout that another
      // observer then has to be re-notified about, and the notifications are
      // simply delivered next frame. The timeline's pins run inside observer
      // callbacks by design, so the notice can fire in normal use; reporting
      // it would bury real errors under it. No error object accompanies it.
      if (event.error == null && BENIGN_WINDOW_ERRORS.test(event.message ?? '')) return;
      reporter.captureThrown(event.error ?? event.message, {
        source: 'window.onerror',
        message: event.message || undefined,
        detail: event.filename
          ? `${event.filename}:${event.lineno}:${event.colno}`
          : undefined,
      });
    };

    // An unhandled promise rejection. The reason is arbitrary (`throw 'oops'`,
    // an ApiError, an object) — `describeThrown` handles all of them.
    const onRejection = (event: PromiseRejectionEvent): void => {
      reporter.captureThrown(event.reason, { source: 'unhandledrejection' });
    };

    // Reconnect signal: the reporter held offline reports for exactly this.
    const onOnline = (): void => {
      reporter.flush();
    };

    target.addEventListener('error', onError as EventListener);
    target.addEventListener('unhandledrejection', onRejection as EventListener);
    target.addEventListener('online', onOnline);

    teardown.push(() => {
      target.removeEventListener('error', onError as EventListener);
      target.removeEventListener('unhandledrejection', onRejection as EventListener);
      target.removeEventListener('online', onOnline);
    });
  }

  if (options.gateway) {
    const poller = createGatewayTelemetryPoller(options.gateway, reporter, {
      intervalMs: options.pollIntervalMs ?? GATEWAY_POLL_INTERVAL_MS,
    });
    poller.start();
    teardown.push(() => poller.stop());
  }

  return () => {
    for (const stop of teardown) stop();
  };
}
