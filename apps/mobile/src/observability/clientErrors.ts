/**
 * @cytale/mobile — client-error capture for the React Native client (#88).
 *
 * The mobile half of the shared reporter: the policy (redaction,
 * fingerprinting, dedupe, rate caps, never-throw) lives in
 * `@cytale/api-client` and is identical here and on web. This module owns only
 * the RN capture points and their wiring.
 *
 * ## The hooks, and what this RN version actually offers (0.86.3)
 *
 *   * **`ErrorUtils.setGlobalHandler`** — RN's global handler
 *     (`Libraries/Core/setUpErrorHandling.js` installs its redbox handler
 *     through it, and `Libraries/vendor/core/ErrorUtils.js` exports the same
 *     global object). Ours CHAINS: we report, then call the handler we
 *     replaced, so the redbox/LogBox behaviour a developer relies on is
 *     untouched. Replacing it instead would silently swallow every crash UI.
 *   * **`onunhandledrejection`** — installed additively and chained the same
 *     way. Stated plainly: RN 0.86 does not itself dispatch this hook — its
 *     rejection tracking (`Libraries/promiseRejectionTrackingOptions.js`,
 *     driven by `promise/setimmediate/rejection-tracking`) calls
 *     `ExceptionsManager.handleException` directly, which on the new
 *     architecture goes native and never re-enters the JS global handler. So
 *     this hook catches rejections wherever the environment DOES dispatch them
 *     and defers to RN's own path otherwise; the reporter's fingerprint dedupe
 *     means a rejection that surfaces through both paths is reported ONCE.
 *     Wiring RN's tracker directly would mean replacing RN's own
 *     `onUnhandled`, which is exactly the kind of interception that breaks the
 *     developer experience on the next RN upgrade.
 *
 * The socket story is NOT re-instrumented: it is the gateway client's existing
 * telemetry, polled with the same shared poller web uses.
 */

import {
  ClientErrorReporter,
  createGatewayTelemetryPoller,
  DEFAULT_GATEWAY_POLL_INTERVAL_MS,
  type ClientErrorPayload,
  type TelemetrySource,
} from '@cytale/api-client';

/** The one thing this module needs from the api client. */
export interface ClientErrorSender {
  reportClientError(payload: ClientErrorPayload): Promise<void>;
}

/** The RN global error handler shape (`ErrorUtils`). */
type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler?: () => GlobalErrorHandler;
  setGlobalHandler?: (handler: GlobalErrorHandler) => void;
}

interface GlobalWithErrorHandlers {
  ErrorUtils?: ErrorUtilsLike;
  onunhandledrejection?: ((event: { reason?: unknown } | unknown) => void) | null;
}

const globals = globalThis as unknown as GlobalWithErrorHandlers;

let senderRef: ClientErrorSender | null = null;
let gatewayRef: (() => TelemetrySource | null) | null = null;
let currentRoute: string | undefined;

/** Set by the navigation shell on every route change (see `app/_layout.tsx`). */
export function setClientErrorRoute(route: string | undefined): void {
  currentRoute = route;
}

/** The route the reporter will attach; exported for the wiring's own test. */
export function getClientErrorRoute(): string | undefined {
  return currentRoute;
}

export function setClientErrorSender(sender: ClientErrorSender | null): void {
  senderRef = sender;
}

/**
 * Late-bound gateway accessor: `installMobileErrorHandlers()` runs at module
 * bootstrap (before any session exists) while the gateway client is created by
 * the session provider. Redirecting through this ref lets the install happen
 * FIRST — so an error during the very first render is already reportable —
 * without the two having to be ordered against each other.
 */
export function setClientErrorGateway(getter: (() => TelemetrySource | null) | null): void {
  gatewayRef = getter;
}

/**
 * Build identity. `EXPO_PUBLIC_CYTALE_VERSION` is inlined by Expo at bundle
 * time (the mobile counterpart of the web bundle's `__CYTALE_VERSION__`); a
 * build that does not set it falls back to the app version from `app.json`
 * (`expo-constants`), then to `dev` so the field is never a lie.
 */
export function buildVersion(): string {
  const fromEnv = process.env.EXPO_PUBLIC_CYTALE_VERSION;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;

  try {
    // Required lazily: a test or a non-Expo runtime must not fail to load this
    // module over a version string.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const constants = require('expo-constants') as {
      default?: { expoConfig?: { version?: string } };
      expoConfig?: { version?: string };
    };
    const version = constants.default?.expoConfig?.version ?? constants.expoConfig?.version;
    return typeof version === 'string' && version.length > 0 ? version : 'dev';
  } catch {
    return 'dev';
  }
}

export const clientErrors = new ClientErrorReporter({
  client: 'mobile',
  version: buildVersion,
  route: () => currentRoute,
  send: payload => {
    const sender = senderRef;
    if (!sender) return Promise.reject(new Error('client error sender not installed'));
    return sender.reportClientError(payload);
  },
});

export interface InstallOptions {
  /** The api client that carries the report to the server. */
  api?: ClientErrorSender;
  /** Override the reporter (tests). Defaults to the shared `clientErrors`. */
  reporter?: ClientErrorReporter;
  /**
   * Reads the live gateway client. Defaults to the late-bound ref set by
   * `setClientErrorGateway` (the session provider), which is the production
   * path; passing one explicitly is the test path.
   */
  gateway?: () => TelemetrySource | null;
  pollIntervalMs?: number;
  /** Override the globals object (tests). */
  target?: GlobalWithErrorHandlers;
}

/**
 * Install the RN capture points. Returns an uninstall function; the app calls
 * it once at boot and never uninstalls, the suite uses it between cases.
 */
export function installMobileErrorHandlers(options: InstallOptions = {}): () => void {
  const reporter = options.reporter ?? clientErrors;
  const target = options.target ?? globals;

  if (options.api) senderRef = options.api;

  const teardown: Array<() => void> = [];
  const errorUtils = target.ErrorUtils;

  if (errorUtils?.setGlobalHandler) {
    // CHAIN, never replace: the previous handler is RN's own (redbox on dev,
    // silent native reporting in release). Losing it would be a worse bug than
    // the crash we are reporting.
    const previous = errorUtils.getGlobalHandler?.();

    const handler: GlobalErrorHandler = (error, isFatal) => {
      reporter.captureThrown(error, {
        source: 'window.onerror',
        detail: isFatal === undefined ? undefined : `fatal=${String(isFatal)}`,
      });
      previous?.(error, isFatal);
    };

    errorUtils.setGlobalHandler(handler);

    teardown.push(() => {
      errorUtils.setGlobalHandler?.(previous ?? (() => undefined));
    });
  }

  // The rejection hook, chained the same way (see the moduledoc for exactly
  // how far it reaches on this RN version).
  const previousRejection = target.onunhandledrejection ?? null;
  const onRejection = (event: { reason?: unknown } | unknown): void => {
    const reason =
      event !== null && typeof event === 'object' && 'reason' in (event as object)
        ? (event as { reason?: unknown }).reason
        : event;
    reporter.captureThrown(reason, { source: 'unhandledrejection' });
    previousRejection?.(event);
  };
  target.onunhandledrejection = onRejection;

  teardown.push(() => {
    target.onunhandledrejection = previousRejection;
  });

  if (options.gateway) {
    setClientErrorGateway(options.gateway);
  }

  // The socket-story poller starts unconditionally: it reports nothing until a
  // gateway client exists, and it is the SAME shared poller web runs.
  const poller = createGatewayTelemetryPoller(
    () => gatewayRef?.() ?? null,
    reporter,
    { intervalMs: options.pollIntervalMs ?? DEFAULT_GATEWAY_POLL_INTERVAL_MS }
  );
  poller.start();
  teardown.push(() => poller.stop());

  return () => {
    for (const stop of teardown) stop();
  };
}
