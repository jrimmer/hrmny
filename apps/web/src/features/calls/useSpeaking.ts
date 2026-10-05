/**
 * @cytale/web — the React binding for the extracted speaking monitor.
 *
 * The monitor itself (per-remote-stream amplitude polling, identity-stable
 * speaking sets) moved to `@cytale/calls` with the rest of the engine; it is
 * platform-neutral apart from its injected `SpeakingEnv`. Two things stayed
 * here, because they are web/React facts and the package is deliberately
 * React-free:
 *
 *   - `browserSpeakingEnv()` — the WebAudio context factory (browserEnv.ts,
 *     injected by webWiring.ts);
 *   - `useSpeakingSet()` — the `useSyncExternalStore` binding the call
 *     surfaces subscribe with.
 */

import { useSyncExternalStore } from 'react';

export {
  SPEAKING_INTERVAL_MS_DEFAULT,
  SPEAKING_THRESHOLD_DEFAULT,
  SpeakingMonitor,
  type AnalyserNodeLike,
  type AudioContextLike,
  type AudioSourceNodeLike,
  type SpeakingEnv,
  type SpeakingMonitorOptions,
} from '@cytale/calls';

export { browserSpeakingEnv } from './browserEnv.js';

/**
 * Bind any (subscribe, getSnapshot) speaking source to React. Kept generic
 * so this module stays engine-import-free (no import cycle); the
 * default-engine binding (`useCallSpeaking`) lives in useCall.ts.
 */
export function useSpeakingSet(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => ReadonlySet<string>,
): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
