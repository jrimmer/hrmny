/**
 * Settings accessibility (plan 004 M10, R18).
 *
 * The settings suite's R18 half: every interactive control on the surface
 * exposes an accessible name, every tappable target meets the 44pt floor, and
 * the reading order is the surface's rendered DOM order (asserted as an order
 * of controls, never a snapshot). The style-flattening technique is copied
 * from `messages/__tests__/MessageRow.test.tsx`; the name/floor pairing is the
 * one `navigation/__tests__/shell.test.tsx` holds the shell to.
 *
 * Scope honesty: these are automated checks over the rendered tree. R18's
 * human half — a VoiceOver/TalkBack walkthrough of the primary flows without a
 * dead end — is NOT covered here and stays a manual acceptance step.
 */
import { render, screen, userEvent, waitFor, within } from '@testing-library/react-native';

import type { MyIntegration } from '@cytale/api-client';

import { AccountSection } from '../AccountSection';
import { AppearanceSection } from '../AppearanceSection';
import { IntegrationsSection } from '../IntegrationsSection';
import { SettingsList } from '../SettingsList';
import {
  buildSettingsHarness,
  jsonResponse,
  SEEDED_PAIR,
  USER,
  userEnvelope,
  type RecordedRequest,
  type StubHandler,
} from './support';

/** Flatten a (possibly array) RN style prop into a plain object. */
function styleOf(element: { props: { style?: unknown } }): Record<string, unknown> {
  return Object.assign(
    {},
    ...([] as unknown[])
      .concat(element.props.style ?? [])
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      ),
  );
}

/**
 * The accessible name the surface set on a control. Every control under test
 * sets one explicitly; a missing name fails loudly rather than sorting a
 * non-control into an order assertion.
 */
function namedLabelOf(element: { props: Record<string, unknown> }): string {
  const label = element.props['aria-label'] ?? element.props.accessibilityLabel;
  if (typeof label !== 'string' || label === '') {
    throw new Error('control without an explicit accessible label — see the name assertions');
  }
  return label;
}

/** Test ids, in the tree order the renderer produced. */
function testIdsOf(elements: { props: Record<string, unknown> }[]): string[] {
  return elements.map((element) => String(element.props.testID));
}

/** A settings harness whose list/section never needs the wire. */
function idleHarness() {
  return buildSettingsHarness(
    () => {
      throw new Error('this surface performs no fetches');
    },
    { user: USER },
  );
}

/** The routes the Account section's real api client round-trips here. */
function accountHandler(): StubHandler {
  return (request: RecordedRequest) => {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === 'GET /api/v1/users/@me') return jsonResponse(userEnvelope(USER));
    if (route === 'PATCH /api/v1/users/@me') {
      const patch = request.body as { display_name?: string };
      return jsonResponse(userEnvelope({ ...USER, display_name: patch.display_name ?? null }));
    }
    throw new Error(`unstubbed route ${route}`);
  };
}

const BOT: MyIntegration = {
  id: '5001',
  name: 'Shipwright',
  kind: 'bot',
  created_at: '2026-08-01T00:00:00.000Z',
  online: true,
};
const UNNAMED_AGENT: MyIntegration = {
  id: '5002',
  name: null,
  kind: 'agent',
  created_at: null,
  online: false,
};

describe('SettingsList — R18', () => {
  const ROWS = [
    { testID: 'settings-row-account', name: 'Account' },
    { testID: 'settings-row-appearance', name: 'Appearance' },
    { testID: 'settings-row-integrations', name: 'Agents' },
    { testID: 'settings-row-logout', name: 'Log out' },
  ] as const;

  it('gives every row an accessible name and a 44pt target', async () => {
    const { services } = idleHarness();
    await render(<SettingsList services={services} onOpenSection={() => {}} />);

    for (const row of ROWS) {
      const control = screen.getByTestId(row.testID);
      expect(control).toHaveAccessibleName(row.name);
      expect(control.props.accessibilityRole).toBe('button');
      expect(styleOf(control).minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('reads in rendered order: the three sections, then Log out last', async () => {
    const { services } = idleHarness();
    await render(<SettingsList services={services} onOpenSection={() => {}} />);

    // `getAllBy*` returns tree order — the order a screen reader walks.
    expect(screen.getAllByRole('button').map(namedLabelOf)).toEqual(ROWS.map((row) => row.name));
  });
});

describe('AccountSection — R18', () => {
  async function renderAccount() {
    const harness = buildSettingsHarness(accountHandler(), { seed: SEEDED_PAIR, user: USER });
    await render(<AccountSection services={harness.services} />);
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());
    return harness;
  }

  it('names every control and reaches the 44pt floor', async () => {
    await renderAccount();

    const controls = [
      { testID: 'account-display-name', name: 'Display name' },
      { testID: 'account-save', name: 'Save changes' },
      { testID: 'account-send-reset', name: 'Send password reset email' },
      { testID: 'account-signout-everywhere', name: 'Sign out everywhere' },
    ] as const;

    for (const control of controls) {
      const element = screen.getByTestId(control.testID);
      expect(element).toHaveAccessibleName(control.name);
      expect(styleOf(element).minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('keeps the reading order the form intends: name field, save, password, sessions', async () => {
    await renderAccount();

    const CONTROLS = new Set([
      'account-display-name',
      'account-save',
      'account-send-reset',
      'account-signout-everywhere',
    ]);
    const order = testIdsOf(screen.getAllByTestId(/^account-/)).filter((id) => CONTROLS.has(id));

    expect(order).toEqual([
      'account-display-name',
      'account-save',
      'account-send-reset',
      'account-signout-everywhere',
    ]);
  });

  it('puts the confirm’s Cancel before the destructive action', async () => {
    await renderAccount();

    const user = userEvent.setup();
    await user.press(screen.getByTestId('account-signout-everywhere'));

    const confirm = screen.getByTestId('account-signout-confirm');
    const buttons = within(confirm).getAllByRole('button');
    expect(buttons.map(namedLabelOf)).toEqual(['Cancel', 'Sign out everywhere']);
    for (const button of buttons) {
      expect(button).toHaveAccessibleName();
      expect(styleOf(button).minHeight).toBeGreaterThanOrEqual(44);
    }
  });
});

describe('AppearanceSection — R18', () => {
  it('labels the theme group and gives both options a name and a 44pt target', async () => {
    await render(<AppearanceSection />);

    // The group and its options are plain Views: the role and the label are
    // declared, but no `accessible` flag — so RNTL's role queries (which
    // require an accessibility element) cannot see them. The declared contract
    // is asserted off the props instead.
    const group = screen.getByLabelText('Color theme');
    expect(group.props.accessibilityRole).toBe('radiogroup');

    const options = [
      { testID: 'appearance-theme-dark', name: "Dark — Hrmny's theme" },
      { testID: 'appearance-theme-light', name: 'Light — coming soon' },
    ] as const;

    for (const option of options) {
      const element = screen.getByTestId(option.testID);
      expect(element.props.accessibilityRole).toBe('radio');
      expect(element).toHaveAccessibleName(option.name);
      expect(styleOf(element).minHeight).toBeGreaterThanOrEqual(44);
    }

    // The rendered order is the choice order: Dark, then the disabled Light.
    expect(testIdsOf(screen.getAllByTestId(/^appearance-theme-/))).toEqual([
      'appearance-theme-dark',
      'appearance-theme-light',
    ]);
  });
});

describe('IntegrationsSection — R18', () => {
  it('names the retry control and reaches the 44pt floor', async () => {
    const harness = buildSettingsHarness(() =>
      jsonResponse({ error: { key: 'server_error', message: 'rollup down' } }, 500),
    );
    await render(<IntegrationsSection services={harness.services} />);
    await waitFor(() => expect(screen.getByTestId('surface-error')).toBeTruthy());

    const retry = screen.getByTestId('integrations-retry');
    expect(retry).toHaveAccessibleName('Retry');
    expect(retry.props.accessibilityRole).toBe('button');
    expect(styleOf(retry).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('announces one stop per integration, in the order the rollup returned', async () => {
    const harness = buildSettingsHarness(() =>
      jsonResponse({ integrations: [BOT, UNNAMED_AGENT] }),
    );
    await render(<IntegrationsSection services={harness.services} />);
    await waitFor(() => expect(screen.getByTestId('integrations-list')).toBeTruthy());

    const rows = screen.getAllByTestId(/^integration-row-/);
    expect(testIdsOf(rows)).toEqual([
      `integration-row-${BOT.id}`,
      `integration-row-${UNNAMED_AGENT.id}`,
    ]);

    // The read-only row is one announcement, not a scatter of fragments.
    expect(rows[0]).toHaveAccessibleName('Shipwright, Bot, online');
    expect(rows[1]).toHaveAccessibleName('Unnamed Agent, Agent, offline');
  });
});
