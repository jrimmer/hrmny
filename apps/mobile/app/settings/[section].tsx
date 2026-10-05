/**
 * @cytale/mobile — one settings section route (plan 004 M10; R14/R15).
 *
 * The pushed half of the list→section stack: a title bar with the back
 * affordance and the shell's states-first body. The section components own
 * their own fetches and render their loading / error / empty states through
 * the shell's announced state components; this route owns the frame and the
 * section dispatch, so an unknown segment renders an honest not-found state
 * instead of a blank body.
 */
import '../../src/navigation/bootstrap';

import { router, useLocalSearchParams } from 'expo-router';

import { useShell } from '../../src/navigation/ShellContext';
import { useSurfaceStates } from '../../src/navigation/shellState';
import { SurfaceScaffold } from '../../src/navigation/SurfaceScaffold';
import { EmptyState } from '../../src/navigation/SurfaceStates';
import { AccountSection } from '../../src/settings/AccountSection';
import { AppearanceSection } from '../../src/settings/AppearanceSection';
import { IntegrationsSection } from '../../src/settings/IntegrationsSection';
import { useSettingsServices } from '../../src/settings/services';
import { SectionScroll } from '../../src/settings/ui';

const TITLES: Record<string, string> = {
  account: 'Account',
  appearance: 'Appearance',
  integrations: 'Integrations',
};

export default function SettingsSectionScreen() {
  const { section } = useLocalSearchParams<{ section: string }>();
  const { openDrawer } = useShell();
  const services = useSettingsServices();
  const shared = useSurfaceStates();
  const key = typeof section === 'string' ? section : '';
  const title = TITLES[key] ?? 'Settings';

  const body = (() => {
    switch (key) {
      case 'account':
        return <AccountSection services={services} />;
      case 'appearance':
        return <AppearanceSection />;
      case 'integrations':
        return <IntegrationsSection services={services} />;
      default:
        return (
          <EmptyState
            title="Section not found"
            hint="Pick a section from the settings list."
            testID="settings-section-not-found"
          />
        );
    }
  })();

  return (
    <SurfaceScaffold
      testID="surface-settings-section"
      title={title}
      onOpenDrawer={openDrawer}
      onBack={() => router.back()}
      states={{ ...shared, empty: false }}
    >
      {/* The section body scrolls with keyboard taps passing through, so the
          first tap on Save (AE5's edit-name step) fires instead of only
          dismissing the keyboard. */}
      <SectionScroll>{body}</SectionScroll>
    </SurfaceScaffold>
  );
}
