/**
 * @cytale/web — responsive breakpoint hook (U18, hardened by plan 003 U7).
 *
 * The shell's mobile collapse contract. jsdom has no layout engine, so the
 * default is desktop (SSR/first-render parity with the CSS cascade) and
 * matchMedia drives updates where available.
 *
 * Defensive re-evaluation (R10): the audit observed a stranded branch — the
 * UI stayed mobile after the viewport crossed 768px while the query already
 * reported desktop, i.e. a missed `change` event. resize (debounced), focus,
 * and visibilitychange re-read the queries so a lost event can't strand
 * the wrong branch; this also covers the Tauri shell where window resizing
 * is routine.
 *
 * Since the 768–1279px fix this is a thin view over `useShellBand`, which owns
 * the band contract (phone | tablet | desktop). Two independent width tests
 * are what produced the defect this hook's sibling fixed — the CSS dropped a
 * grid track while this predicate kept a region mounted — so keep every shell
 * width decision in `useShellBand`.
 */
import { useShellBand } from './useShellBand.js';

export function useIsMobileWidth(): boolean {
  return useShellBand() === 'phone';
}
