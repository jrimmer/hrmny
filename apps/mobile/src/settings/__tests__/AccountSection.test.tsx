/**
 * AccountSection (plan 004 M10, R14/R15) — the settings contract's Account
 * section over the real api client.
 *
 * Every round-trip scenario drives `CytaleApiClient` through the stubbed
 * transport in `support.tsx`; the session is a real `SessionManager` on the
 * memory token adapter, so "signs out everywhere" is proven against the
 * injected storage, not a mock.
 */
import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import { AccountSection } from '../AccountSection';
import {
  buildSettingsHarness,
  emptyResponse,
  jsonResponse,
  seedRoster,
  SEEDED_PAIR,
  USER,
  userEnvelope,
  type RecordedRequest,
  type StubHandler,
} from './support';

function accountHandler(overrides: Partial<Record<string, StubHandler>> = {}): StubHandler {
  return (request: RecordedRequest) => {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    const override = overrides[route];
    if (override) return override(request);
    if (route === 'GET /api/v1/users/@me') return jsonResponse(userEnvelope(USER));
    if (route === 'PATCH /api/v1/users/@me') {
      const patch = request.body as { display_name?: string };
      return jsonResponse(userEnvelope({ ...USER, display_name: patch.display_name ?? null }));
    }
    if (route === 'POST /api/v1/auth/password-reset/request') return emptyResponse(202);
    if (route === 'DELETE /api/v1/users/@me/sessions') return emptyResponse(204);
    throw new Error(`unstubbed route ${route}`);
  };
}

async function renderAccount(
  handler: StubHandler = accountHandler(),
  // Signed in by default: the sections read the session the app owns.
  options: Parameters<typeof buildSettingsHarness>[1] = { seed: SEEDED_PAIR, user: USER },
) {
  const harness = buildSettingsHarness(handler, options);
  seedRoster(harness.store, USER.id, USER.username);
  const view = await render(<AccountSection services={harness.services} />);
  return { harness, view };
}

describe('AccountSection — identity load', () => {
  it('loads the account through GET /users/@me and renders the identity rows', async () => {
    // Hold the response open so the loading state is observable, not raced.
    let release: (() => void) | null = null;
    const handler = accountHandler({
      'GET /api/v1/users/@me': () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(userEnvelope(USER)));
        }),
    });
    const { harness } = await renderAccount(handler);

    expect(screen.getByTestId('surface-loading')).toBeTruthy();
    expect(release).not.toBeNull();
    (release as unknown as () => void)();
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());

    const load = harness.calls.find((call) => call.method === 'GET');
    expect(load?.url).toBe('http://test.local/api/v1/users/@me');
    // The stub-transport client presents the session's access token.
    expect(load?.headers.authorization).toBe('Bearer access-token-1');

    expect(screen.getByTestId('account-username')).toHaveTextContent('jordan');
    expect(screen.getByTestId('account-email')).toHaveTextContent('j@example.com');
    expect(screen.getByTestId('account-verified')).toBeTruthy();
    expect(screen.getByTestId('account-created')).not.toHaveTextContent('…');
  });

  it('renders the error state with a retry when the load fails', async () => {
    let failing = true;
    const handler = accountHandler({
      'GET /api/v1/users/@me': () =>
        failing
          ? jsonResponse({ error: { key: 'server_error', message: 'boom' } }, 500)
          : jsonResponse(userEnvelope(USER)),
    });
    const { harness } = await renderAccount(handler);

    await waitFor(() => expect(screen.getByTestId('surface-error')).toBeTruthy());
    expect(screen.getByTestId('surface-error')).toHaveTextContent('boom');

    failing = false;
    const user = userEvent.setup();
    await user.press(screen.getByTestId('account-retry'));

    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());
    expect(harness.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });
});

describe('AccountSection — profile save', () => {
  it('round-trips the display name and converges the roster row', async () => {
    const { harness } = await renderAccount();
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());

    const user = userEvent.setup();
    await user.clear(screen.getByTestId('account-display-name'));
    await user.type(screen.getByTestId('account-display-name'), 'Ace Rowan');
    await user.press(screen.getByTestId('account-save'));

    await waitFor(() => expect(screen.getByTestId('account-saved')).toBeTruthy());

    const patch = harness.calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toBe('http://test.local/api/v1/users/@me');
    expect(patch?.body).toEqual({ display_name: 'Ace Rowan' });
    expect(patch?.headers.authorization).toBe('Bearer access-token-1');

    // The roster row converged so member lists show the new name immediately
    // — as the display name; a nickname is per-workspace (#169).
    expect(harness.store.getState().membersById[USER.id]?.display_name).toBe('Ace Rowan');
    expect(harness.store.getState().membersById[USER.id]?.nickname).toBeNull();
    expect(harness.session.authStore.getState().currentUser?.display_name).toBe('Ace Rowan');
  });

  it('keeps the save control disabled until the draft is dirty', async () => {
    await renderAccount();
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());

    expect(screen.getByTestId('account-save').props.accessibilityState).toMatchObject({
      disabled: true,
    });

    const user = userEvent.setup();
    await user.type(screen.getByTestId('account-display-name'), '!');
    expect(screen.getByTestId('account-save').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it('renders the save failure as an alert and no saved flash', async () => {
    const handler = accountHandler({
      'PATCH /api/v1/users/@me': () =>
        jsonResponse({ error: { key: 'validation', message: 'name too long' } }, 422),
    });
    await renderAccount(handler);
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());

    const user = userEvent.setup();
    await user.type(screen.getByTestId('account-display-name'), 'X');
    await user.press(screen.getByTestId('account-save'));

    await waitFor(() => expect(screen.getByTestId('account-save-error')).toBeTruthy());
    expect(screen.getByTestId('account-save-error')).toHaveTextContent('name too long');
    expect(screen.queryByTestId('account-saved')).toBeNull();
  });
});

describe('AccountSection — password reset', () => {
  it('requests the reset email for the account address and confirms', async () => {
    const { harness } = await renderAccount();
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());

    const user = userEvent.setup();
    await user.press(screen.getByTestId('account-send-reset'));

    await waitFor(() => expect(screen.getByTestId('account-reset-sent')).toBeTruthy());
    const request = harness.calls.find((call) => call.url.endsWith('/auth/password-reset/request'));
    expect(request?.method).toBe('POST');
    expect(request?.body).toEqual({ email: 'j@example.com' });
  });
});

describe('AccountSection — sign out everywhere', () => {
  it('requires the inline confirm, revokes every session, and lands unauthenticated with storage cleared', async () => {
    const { harness } = await renderAccount(accountHandler(), { seed: { accessToken: 'a', refreshToken: 'r' }, user: USER });
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());

    const user = userEvent.setup();
    await user.press(screen.getByTestId('account-signout-everywhere'));
    expect(harness.calls.some((call) => call.method === 'DELETE')).toBe(false);

    await user.press(screen.getByTestId('account-signout-confirm-yes'));

    await waitFor(() => expect(harness.session.authStore.getState().status).toBe('unauthenticated'));
    const revoke = harness.calls.find((call) => call.method === 'DELETE');
    expect(revoke?.url).toBe('http://test.local/api/v1/users/@me/sessions');

    // "Returns to auth": the store the shell's gate keys on is signed out…
    expect(harness.session.authStore.getState().currentUser).toBeNull();
    // …and the injected credential adapter is empty (Keychain/Keystore in prod).
    expect(harness.storage.read()).toBeNull();
    expect(screen.queryByTestId('account-signout-confirm')).toBeNull();
  });

  it('cancel steps the confirm back down without calling the API', async () => {
    const { harness } = await renderAccount();
    await waitFor(() => expect(screen.getByTestId('settings-account')).toBeTruthy());

    const user = userEvent.setup();
    await user.press(screen.getByTestId('account-signout-everywhere'));
    await user.press(screen.getByTestId('account-signout-cancel'));

    expect(screen.queryByTestId('account-signout-confirm')).toBeNull();
    expect(harness.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(harness.session.authStore.getState().status).not.toBe('unauthenticated');
  });
});
