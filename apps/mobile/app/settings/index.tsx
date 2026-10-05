/**
 * @cytale/mobile — settings list route (plan 004 M10; R14).
 *
 * The list→section stack's first screen: Account, Appearance (dark-only, as
 * web), Integrations (read-only observe), and Log out as the FINAL row. The
 * list itself lives in `src/settings/SettingsList`; this route owns only the
 * shell wiring (title bar, drawer affordance, router push).
 *
 * The list has no fetch of its own, so the shell's `empty` flag is cleared
 * here — a workspace with no channels never blanks the settings surface.
 */
import '../../src/navigation/bootstrap';

import { router } from 'expo-router';

import { settingsHref } from '../../src/navigation/routes';
import { useShell } from '../../src/navigation/ShellContext';
import { useSurfaceStates } from '../../src/navigation/shellState';
import { SurfaceScaffold } from '../../src/navigation/SurfaceScaffold';
import { SettingsList } from '../../src/settings/SettingsList';
import { useSettingsServices } from '../../src/settings/services';

export default function SettingsScreen() {
  const { openDrawer } = useShell();
  const services = useSettingsServices();
  const shared = useSurfaceStates();

  return (
    <SurfaceScaffold
      testID="surface-settings"
      title="Settings"
      onOpenDrawer={openDrawer}
      states={{ ...shared, empty: false }}
      scroll
    >
      <SettingsList
        services={services}
        onOpenSection={(section) => router.push(settingsHref(section) as never)}
      />
    </SurfaceScaffold>
  );
}
