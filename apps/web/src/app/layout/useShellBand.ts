/**
 * @cytale/web — the shell's band contract (the single source of truth).
 *
 * The 768–1279px defect was a disagreement, not a missing rule: `shell.css`
 * dropped the grid's FOURTH track at 1279px while `AppShell`'s aside guard
 * kept rendering the members rail until 768px. That left the aside as a grid
 * child with no track, so auto-placement dropped it into the shell's SECOND
 * row — the member list became a 72px strip under the identity panel and the
 * left cluster + pane were robbed of the row they should have had (at the
 * owner's 834×1210 reference width that abandoned 44% of the screen).
 *
 * So: one hook owns the band, every consumer reads it, and the CSS is written
 * to match. Do not add a second width test anywhere in the shell.
 *
 *   phone   < 768px    MobileTopbar chrome, drawers, thread sheet
 *   tablet  768–1279px rail + sidebar + pane; members/thread REPLACE the pane
 *   desktop ≥ 1280px   four columns: rail | sidebar | pane | members
 *
 * Banding is by WIDTH only, deliberately. An iPhone in landscape is 852–956px
 * wide — wider than the phone breakpoint — and the owner's position is that it
 * should "initially largely follow the iPad layout", so width is what decides
 * and landscape phones inherit the tablet band instead of needing a mode of
 * their own. A height-based rule (`height < 500` → phone) was considered and
 * rejected for exactly that reason: it would have prevented the support the
 * owner asked for.
 *
 * jsdom has no layout engine, so the default is desktop (SSR/first-render
 * parity with the CSS cascade) and matchMedia drives updates where available.
 * Defensive re-evaluation (R10): the audit once caught a stranded branch — the
 * UI stayed mobile past 768px while the query already reported desktop, i.e. a
 * missed `change` event — so resize (debounced), focus, and visibilitychange
 * re-read the queries too. This also covers the Tauri shell, where window
 * resizing is routine.
 */
import { useEffect, useState } from 'react';

const PHONE_QUERY = '(max-width: 767px)';
const TABLET_QUERY = '(max-width: 1279px)';
const RESIZE_DEBOUNCE_MS = 150;

export type ShellBand = 'phone' | 'tablet' | 'desktop';

/**
 * Read the band from the live queries. Tolerates a matchMedia stub that only
 * knows some of the queries (jsdom tests, older mocks): an unanswered query
 * reads as a miss rather than throwing.
 */
function readBand(): ShellBand {
  const match = globalThis.window?.matchMedia;
  if (typeof match !== 'function') return 'desktop';
  if (match(PHONE_QUERY)?.matches === true) return 'phone';
  if (match(TABLET_QUERY)?.matches === true) return 'tablet';
  return 'desktop';
}

export function useShellBand(): ShellBand {
  const [band, setBand] = useState<ShellBand>(readBand);

  useEffect(() => {
    const phone = window.matchMedia(PHONE_QUERY);
    const tablet = window.matchMedia(TABLET_QUERY);
    const update = () => setBand(readBand());
    update();
    phone.addEventListener('change', update);
    tablet.addEventListener('change', update);

    let resizeTimer: number | undefined;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(update, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      phone.removeEventListener('change', update);
      tablet.removeEventListener('change', update);
      window.removeEventListener('resize', onResize);
      window.clearTimeout(resizeTimer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return band;
}
