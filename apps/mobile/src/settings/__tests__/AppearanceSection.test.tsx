/**
 * AppearanceSection (plan 004 M10, R14) — dark-only, matching web.
 *
 * The section performs no fetch: the theme truth is a build-time constant
 * (`theme.scheme === 'dark'`), so the test pins the honest rendering — Dark
 * selected, Light visible-but-disabled with the reason, never a fake choice.
 */
import { render, screen } from '@testing-library/react-native';

import { AppearanceSection } from '../AppearanceSection';

describe('AppearanceSection', () => {
  it('renders dark as the selected theme and light as disabled with a reason', async () => {
    await render(<AppearanceSection />);

    const dark = screen.getByTestId('appearance-theme-dark');
    const light = screen.getByTestId('appearance-theme-light');

    expect(dark.props.accessibilityState).toMatchObject({ checked: true });
    expect(light.props.accessibilityState).toMatchObject({ checked: false, disabled: true });
    expect(light).toHaveTextContent(/coming soon/);
  });

  it('states that the token layer ships light as a remap, not a redesign', async () => {
    await render(<AppearanceSection />);
    expect(screen.getByTestId('settings-appearance')).toHaveTextContent(/pure remap/i);
  });
});
