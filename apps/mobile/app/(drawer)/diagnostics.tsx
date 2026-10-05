/**
 * @cytale/mobile — Diagnostics surface (plan 004 M5).
 *
 * The M1 runtime/protocol report stays a route so it remains reachable on a
 * device; the drawer only links to it in development (`__DEV__`). The
 * screen owns its own scroll view, so the scaffold body stays non-scrolling.
 *
 * The route is gated too, not just the drawer LINK: `cytale://diagnostics`
 * deep-links straight past the drawer, and the screen owns a control that
 * opens a cleartext socket to `ws://localhost:4000`. Outside development the
 * route therefore redirects to the home surface instead of mounting.
 */
import '../../src/navigation/bootstrap';

import { Redirect } from 'expo-router';

import { DiagnosticsScreen } from '../../src/diagnostics/DiagnosticsScreen';
import { useShell } from '../../src/navigation/ShellContext';
import { SurfaceScaffold } from '../../src/navigation/SurfaceScaffold';

export default function DiagnosticsRoute() {
  const { openDrawer } = useShell();

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <SurfaceScaffold testID="surface-diagnostics" title="Diagnostics" onOpenDrawer={openDrawer}>
      <DiagnosticsScreen />
    </SurfaceScaffold>
  );
}
