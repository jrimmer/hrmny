/**
 * @cytale/mobile — native deep-link intent (plan 004 M5, R7).
 *
 * `cytale://channel/<id>` parses as host=`channel`, path=`/<id>`, and Expo
 * Router's native URL extraction keeps only what follows the scheme — so the
 * host segment has to be folded back into the path before routing. This hook
 * runs on every incoming system URL (cold start and foreground), which is why
 * the mapping lives in `src/navigation/routes.ts` as a pure, tested function.
 */
import { normalizeDeepLink } from '../src/navigation/routes';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return normalizeDeepLink(path);
}
