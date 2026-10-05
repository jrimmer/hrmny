/**
 * @cytale/mobile — Integrations surface (plan 004 M5).
 *
 * Reachable from the drawer's workspace strip, exactly as the responsive
 * contract places it (plan-003 KTD2). Read-only observe in v1 (R14): the
 * panel itself is a later unit; the surface and its states are the shell's.
 */
import '../../src/navigation/bootstrap';

import { useShell } from '../../src/navigation/ShellContext';
import { SurfaceScaffold } from '../../src/navigation/SurfaceScaffold';

export default function IntegrationsScreen() {
  const { openDrawer } = useShell();

  return (
    <SurfaceScaffold
      testID="surface-integrations"
      title="Integrations"
      onOpenDrawer={openDrawer}
      emptyTitle="No integrations"
      emptyHint="Installed integrations appear here."
    />
  );
}
