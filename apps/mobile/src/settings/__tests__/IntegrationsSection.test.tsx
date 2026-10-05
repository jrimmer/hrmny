/**
 * IntegrationsSection (plan 004 M10, R14/R15) — the read-only rollup over
 * GET /users/@me/integrations, driven through the real api client.
 */
import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import type { MyIntegration } from '@cytale/api-client';

import { IntegrationsSection } from '../IntegrationsSection';
import { buildSettingsHarness, jsonResponse, type StubHandler } from './support';

const BOT: MyIntegration = {
  id: '5001',
  name: 'Shipwright',
  kind: 'bot',
  created_at: '2026-08-01T00:00:00.000Z',
  online: true,
};
const AGENT: MyIntegration = {
  id: '5002',
  name: null,
  kind: 'agent',
  created_at: null,
  online: false,
};

async function renderIntegrations(handler: StubHandler) {
  const harness = buildSettingsHarness(handler);
  await render(<IntegrationsSection services={harness.services} />);
  return harness;
}

describe('IntegrationsSection', () => {
  it('loads the rollup through the api client and lists it read-only', async () => {
    // Hold the response open so the loading state is observable, not raced.
    let release: (() => void) | null = null;
    const harness = await renderIntegrations(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ integrations: [BOT, AGENT] }));
        }),
    );

    expect(screen.getByTestId('surface-loading')).toBeTruthy();
    (release as unknown as () => void)();
    await waitFor(() => expect(screen.getByTestId('integrations-list')).toBeTruthy());

    expect(harness.calls[0]?.url).toBe('http://test.local/api/v1/users/@me/integrations');
    expect(screen.getByTestId(`integration-row-${BOT.id}`)).toHaveTextContent(/Shipwright/);
    expect(screen.getByTestId(`integration-row-${BOT.id}`)).toHaveTextContent(/Bot/);
    expect(screen.getByTestId(`integration-row-${AGENT.id}`)).toHaveTextContent(/Unnamed Agent/);
    // Read-only observe: no lifecycle affordances on the rollup.
    expect(screen.queryByTestId(`integration-manage-${BOT.id}`)).toBeNull();
  });

  it('renders the empty state when the caller has no integrations', async () => {
    await renderIntegrations(() => jsonResponse({ integrations: [] }));

    await waitFor(() => expect(screen.getByTestId('integrations-empty')).toBeTruthy());
    expect(screen.queryByTestId('integrations-list')).toBeNull();
  });

  it('renders the permission-denied state for a forbidden read', async () => {
    await renderIntegrations(() =>
      jsonResponse({ error: { key: 'forbidden', code: 40301, message: 'not allowed' } }, 403),
    );

    await waitFor(() => expect(screen.getByTestId('permission-denied')).toBeTruthy());
    expect(screen.getByTestId('permission-denied')).toHaveTextContent(/not allowed/);
  });

  it('renders the error state and retries the fetch', async () => {
    let failing = true;
    const harness = await renderIntegrations(() =>
      failing
        ? jsonResponse({ error: { key: 'server_error', message: 'rollup down' } }, 500)
        : jsonResponse({ integrations: [BOT] }),
    );

    await waitFor(() => expect(screen.getByTestId('surface-error')).toBeTruthy());
    expect(screen.getByTestId('surface-error')).toHaveTextContent('rollup down');

    failing = false;
    const user = userEvent.setup();
    await user.press(screen.getByTestId('integrations-retry'));

    await waitFor(() => expect(screen.getByTestId('integrations-list')).toBeTruthy());
    expect(harness.calls).toHaveLength(2);
  });
});
