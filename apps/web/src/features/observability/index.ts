/**
 * @cytale/web — the client-error seam (#88). See `clientErrors.ts` for the
 * policy and `AppErrorBoundary.tsx` for the React half.
 */
export {
  AppErrorBoundary,
  type ErrorBoundaryProps,
} from './AppErrorBoundary.js';
export {
  GATEWAY_POLL_INTERVAL_MS,
  clientErrors,
  createGatewayTelemetryPoller,
  installClientErrorCapture,
  setClientErrorSender,
  type ClientErrorSender,
  type GatewayTelemetryPoller,
  type InstallOptions,
} from './clientErrors.js';
