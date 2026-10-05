/**
 * @cytale/mobile — session-loss watcher (plan 004 M12, R6).
 *
 * The React binding for `watchSessionLoss`: the root gate mounts it once, and
 * the notice store (`sessionNotice.ts`) owns the implementation and the copy.
 */
import { useEffect } from 'react';

import { watchSessionLoss } from './sessionNotice';
import { useSession } from '../navigation/session';

/** Mounted once by the root gate. */
export function useSessionWatch(): void {
  const session = useSession();
  useEffect(() => watchSessionLoss(session), [session]);
}
