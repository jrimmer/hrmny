/**
 * Passkey sign-in against a real server, with Chromium's virtual WebAuthn
 * authenticator standing in for the phone (owner report 2026-10-02: "I
 * confirm on my phone and send it, then it drops me at the login").
 *
 * Needs the server booted production-shaped — `E2E_PASSKEYS=1
 * scripts/e2e-live.sh e2e/passkey-login.live.spec.ts` sets
 * CYTALE_EXTERNAL_BASE_URL to the server's own origin, so the RP ID
 * (`localhost`) and the expected origin (`http://localhost:<port>`) derive
 * exactly the way a deployment derives them from its domain. Without it the
 * server does not advertise passkeys and this file skips, saying why.
 *
 * Covered, each through the page a person uses:
 *   1. register a passkey (the post-login "Set up a passkey?" ask), sign
 *      out, sign in with the passkey → the shell;
 *   2. a passkey this server has never seen → a visible, specific message,
 *      not a silent bounce back to the form;
 *   3. a cancelled prompt → the visible cancel message.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { expect, test, type CDPSession, type Page } from '@playwright/test';

import { API, registerVerifiedUser } from './helpers';

const NOT_RECOGNIZED =
  "That passkey couldn't sign you in. It may not be registered on this server. Sign in with your password, then add the passkey again in Settings → My Account → Passkeys.";
const CANCELLED = 'Passkey sign-in was cancelled or timed out. Try again, or sign in with your password.';

interface VirtualAuthenticator {
  cdp: CDPSession;
  authenticatorId: string;
}

/** A platform-style authenticator that holds discoverable credentials and verifies the user. */
async function addAuthenticator(page: Page, opts: { presence?: boolean } = {}): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: opts.presence ?? true,
    },
  });
  return { cdp, authenticatorId };
}

async function credentialCount(auth: VirtualAuthenticator): Promise<number> {
  const { credentials } = await auth.cdp.send('WebAuthn.getCredentials', {
    authenticatorId: auth.authenticatorId,
  });
  return credentials.length;
}

async function passkeysAdvertised(page: Page): Promise<boolean> {
  const res = await page.request.get(`${API}/auth/methods`);
  return res.ok() && (await res.json()).webauthn === true;
}

/**
 * The page offers passkeys two ways: the bottom button, and a background
 * autofill (conditional) request armed on the sign-in page. A virtual
 * authenticator answers whichever request reaches it first — a person never
 * does — so each test says which path it means: the autofill probe answers
 * "unavailable" unless the test flips `window.__e2eAutofill` on.
 */
async function controlAutofill(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __e2eAutofill?: boolean };
    w.__e2eAutofill = false;
    const pkc = window.PublicKeyCredential as unknown as {
      isConditionalMediationAvailable?: () => Promise<boolean>;
    };
    const probe = pkc?.isConditionalMediationAvailable?.bind(window.PublicKeyCredential);
    if (pkc && probe) {
      pkc.isConditionalMediationAvailable = () => (w.__e2eAutofill ? probe() : Promise.resolve(false));
    }
  });
}

/** The bottom button — the explicit path whose every failure must speak. */
async function signInWithPasskeyButton(page: Page): Promise<void> {
  const button = page.getByTestId('login-passkey-button');
  await expect(button).toBeVisible();
  await button.click();
}

async function openSettingsAndLogOut(page: Page): Promise<void> {
  // The settings column is a toggle, and it is still open when the same
  // account signs straight back in — only open it when it is closed.
  if (!(await page.getByTestId('settings-nav').isVisible())) {
    await page.getByTestId('user-settings-toggle').click();
  }
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await page.getByTestId('settings-nav-logout').click();
}

test.describe('passkey sign-in (virtual authenticator)', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await passkeysAdvertised(page)),
      'the server does not advertise passkeys — run with E2E_PASSKEYS=1 scripts/e2e-live.sh',
    );
    await controlAutofill(page);
  });

  test('register a passkey, sign out, sign back in with it', async ({ page }) => {
    test.setTimeout(90_000);
    const auth = await addAuthenticator(page);

    const username = await registerVerifiedUser(page, 'pk');

    // A password login on a passkey-enabled server offers enrollment.
    await page.getByTestId('passkey-prompt-setup').click();
    await expect(page.getByTestId('passkey-prompt-done')).toBeVisible();
    expect(await credentialCount(auth)).toBe(1);

    // The bottom button.
    await openSettingsAndLogOut(page);
    await expect(page.getByTestId('login-page')).toBeVisible();
    await signInWithPasskeyButton(page);
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await expect(page.getByTestId('user-panel')).toContainText(username);

    // The automatic offer: on the sign-in page the background (autofill)
    // ceremony signs straight back in once the authenticator answers it.
    await page.evaluate(() => {
      (window as unknown as { __e2eAutofill?: boolean }).__e2eAutofill = true;
    });
    await openSettingsAndLogOut(page);
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await expect(page.getByTestId('user-panel')).toContainText(username);
  });

  test('a passkey this server never registered shows why, instead of bouncing silently', async ({ page }) => {
    const auth = await addAuthenticator(page);
    // A discoverable credential for this RP ID that the server has never seen
    // — the shape of a passkey made for another server, or one removed here.
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await auth.cdp.send('WebAuthn.addCredential', {
      authenticatorId: auth.authenticatorId,
      credential: {
        credentialId: randomBytes(32).toString('base64'),
        isResidentCredential: true,
        rpId: 'localhost',
        privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        userHandle: Buffer.alloc(8, 7).toString('base64'),
        signCount: 0,
      },
    });

    await page.goto('/#/');
    await signInWithPasskeyButton(page);

    const alert = page.getByTestId('login-error');
    await expect(alert).toHaveText(NOT_RECOGNIZED);
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toHaveAttribute('aria-live', 'assertive');
    await expect(alert).toBeFocused();
    // Still on the form, and it still works as the way back in.
    await expect(page.getByRole('textbox', { name: 'Password' })).toBeVisible();
    await expect(page.getByTestId('app-shell')).toHaveCount(0);
  });

  test('a cancelled passkey prompt says it was cancelled', async ({ page }) => {
    // No user presence: the authenticator never answers; the prompt is
    // abandoned the way a person closes the browser's dialog (NotAllowedError).
    await addAuthenticator(page, { presence: false });
    await page.goto('/#/');
    await page.evaluate(() => {
      const original = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = (options?: CredentialRequestOptions) => {
        // Only the explicit (modal) request is cancelled; the background
        // autofill offer keeps its own pending promise.
        if (options?.mediation === 'conditional') return original(options);
        return Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
      };
    });

    await page.getByTestId('login-passkey-button').click();

    const alert = page.getByTestId('login-error');
    await expect(alert).toHaveText(CANCELLED);
    await expect(alert).toBeFocused();
  });
});
