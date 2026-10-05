/**
 * U19 — login: username-or-email + password. Invalid credentials render an
 * inline error and never connect the gateway (connection happens inside
 * session.login success only).
 *
 * #36 — a second, passwordless path rides BELOW the form: "Sign in with a
 * passkey" (the ticket's bottom-button v1). It renders only when the server
 * reports the surface enabled (GET /auth/methods); the ceremony is the
 * discoverable flow (no identifier typed — the browser's picker chooses the
 * identity) and on success the SAME token pair enters the SAME session
 * machinery, so the signed-out continuation resumes identically.
 *
 * Owner direction 2026-09-15 — passkeys are also AUTOMATIC here: when the
 * surface is on and the browser supports conditional mediation, one
 * background ceremony offers the passkey in the username field's autofill
 * (no dialog, no button press). It aborts when the user submits the password
 * or presses the bottom button instead, and any failure stands down silently
 * for the page's life. A successful PASSWORD login also arms the shell's
 * passkey enrollment prompt (passkeyPrompt.ts) — the ask the owner never
 * got while passkeys were "on".
 *
 * #127 — the password path now BRANCHES. When the server's 2FA switch is on,
 * a verified password is not always enough: the login response either mints
 * the classic token pair (mode off, passkey/OIDC flows, and enrolled-free
 * accounts), a `totp_pending` challenge grant (account enrolled — one 6-digit
 * code swaps it for the pair), or an `enrollment_required` grant (mode on,
 * account unenrolled — the QR/confirm walk whose success IS the pair; no
 * skip). Both step completions ride loginWithTokens, so the gateway connect
 * and the signed-out continuation are byte-identical to a plain login. The
 * conditional passkey ceremony cannot interfere: the password submit aborts
 * it before any of this runs, and the steps re-abort defensively on entry.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { AuthTokens } from '@cytale/api-client';

import { describeAuthError } from './authErrors.js';
import { useAuth } from './useAuth.js';
import { api, session, SERVER_ORIGIN_KEY, DEFAULT_SERVER_ORIGIN, ServerOriginError, validateServerOrigin } from './session.js';
import {
  PasskeyError,
  authenticateWithPasskey,
  conditionalMediationAvailable,
  conditionalPasskeySignIn,
  describePasskeyError,
} from './passkeys.js';
import { currentReturnTo, startOidcSignIn } from './oidc.js';
import { isTauri } from '../../tauri/index.js';
import { markPasswordLoginForPasskeyPrompt } from './passkeyPrompt.js';
import { QrSvg } from '../../app/ui/QrSvg.js';
import {
  authCardClass,
  authHeadingClass,
  authPageClass,
  buttonClass,
  errorClass,
  fieldClass,
  ghostButtonClass,
  labelClass,
} from './formStyles.js';

/**
 * The automatic passkey re-arms this long before the server's challenge
 * lapses: a cross-device (phone) confirmation started just before a re-arm
 * would be cut off by it, so the margin is about one such confirmation.
 */
const CONDITIONAL_REFRESH_MARGIN_MS = 60_000;
/** Floor for the re-arm delay, whatever lifetime a server advertises. */
const CONDITIONAL_MIN_REFRESH_MS = 15_000;
/** Shown verify failures after which the automatic offer stops re-arming (the bottom button stays). */
const CONDITIONAL_MAX_FAILURES = 3;

/**
 * Where the login walk stands. `credentials` is today's form; the other two
 * are the #127 branches, each holding the grant the password step minted and
 * the step-display identity the server sent with it.
 */
type LoginStep =
  | { kind: 'credentials' }
  | { kind: 'totp'; grant: string; username: string }
  | { kind: 'enroll'; grant: string; username: string; secret: string; otpauthUri: string };

export function LoginPage({ onNavigate }: { onNavigate?: (to: string) => void }) {
  const { loginWithTokens } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // The desktop shell connects to a USER-CHOSEN server (owner direction
  // 2026-09-19) — the field renders only inside the Tauri shell; browsers are
  // same-origin by construction and never see it.
  const isDesktopShell = isTauri();
  const [server, setServer] = useState(
    (isDesktopShell && typeof localStorage !== 'undefined'
      ? localStorage.getItem(SERVER_ORIGIN_KEY)
      : null) ?? DEFAULT_SERVER_ORIGIN,
  );
  const [serverError, setServerError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // The button exists only when the SERVER offers the surface. A failed
  // methods read hides it too: the password path is unaffected either way.
  // Lane D #4: seeded from the last answer this device saw, so the buttons
  // do not pop in a round trip after the form (the read still refreshes it).
  const [cachedMethods] = useState(readCachedAuthMethods);
  const [passkeysEnabled, setPasskeysEnabled] = useState(cachedMethods?.webauthn === true);
  const [oidcEnabled, setOidcEnabled] = useState(cachedMethods?.oidc === true);
  const [oidcLabel, setOidcLabel] = useState(
    typeof cachedMethods?.oidc_button_label === 'string' && cachedMethods.oidc_button_label !== ''
      ? cachedMethods.oidc_button_label
      : 'Sign in with SSO',
  );
  const [oidcBusy, setOidcBusy] = useState(false);
  // #127: which step of the (possibly branched) login walk is showing.
  const [step, setStep] = useState<LoginStep>({ kind: 'credentials' });
  const [totpCode, setTotpCode] = useState('');
  const [enrollCode, setEnrollCode] = useState('');
  // The conditional-mediation ceremony's controller. Held in a ref so the
  // password submit (and the bottom button) can abort a still-pending
  // automatic ceremony — a late assertion must never race those paths.
  const conditionalAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getAuthMethods()
      .then((methods) => {
        writeCachedAuthMethods(methods);
        if (alive) {
          setPasskeysEnabled(methods.webauthn === true);
          setOidcEnabled(methods.oidc === true);
          if (typeof methods.oidc_button_label === 'string' && methods.oidc_button_label !== '') {
            setOidcLabel(methods.oidc_button_label);
          }
        }
      })
      .catch(() => {
        /* surfaces stay hidden — honest, and never blocks password login */
      });
    return () => {
      alive = false;
    };
  }, []);

  // The AUTOMATIC passkey (conditional mediation): when the server offers the
  // surface and the browser can do it, arm a background ceremony — the
  // passkey then rides the username field's autofill dropdown (the input
  // carries `username webauthn` for exactly this). The promise resolves only
  // when the user picks a passkey there; it never shows a dialog.
  //
  // Two rules keep it from failing silently (owner report 2026-10-02: "I
  // confirm on my phone and send it, then it drops me at the login"):
  //
  //  * The server's challenge has a lifetime, but the browser keeps a
  //    conditional request open indefinitely — so the ceremony RE-ARMS with a
  //    fresh challenge before the old one lapses. Armed once at mount, a
  //    passkey picked minutes later was refused as expired.
  //  * Once the user has picked and confirmed a passkey (a `verify`-stage
  //    failure), the refusal is SHOWN, like the bottom button's, and the
  //    ceremony re-arms so they can try again.
  //
  // Everything before that — no conditional support, the options fetch, an
  // abort from the password submit or the bottom button — stays silent: the
  // user asked the automatic path for nothing yet.
  useEffect(() => {
    if (!passkeysEnabled) return;
    let alive = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const arm = async (failures: number): Promise<void> => {
      const controller = new AbortController();
      conditionalAbort.current = controller;
      let refreshing = false;
      let tokens: AuthTokens;
      try {
        tokens = await conditionalPasskeySignIn(api, controller.signal, (timeoutMs) => {
          refreshTimer = setTimeout(
            () => {
              refreshing = true;
              controller.abort();
            },
            Math.max(timeoutMs - CONDITIONAL_REFRESH_MARGIN_MS, CONDITIONAL_MIN_REFRESH_MS),
          );
        });
      } catch (err) {
        clearTimeout(refreshTimer);
        if (!alive) return;
        if (refreshing) {
          void arm(failures);
          return;
        }
        // The password submit or the bottom button took over.
        if (controller.signal.aborted) return;
        if (err instanceof PasskeyError && err.stage === 'verify') {
          showPasskeyError(err);
          if (failures + 1 < CONDITIONAL_MAX_FAILURES) void arm(failures + 1);
        }
        return;
      }
      clearTimeout(refreshTimer);
      if (!alive) return;
      // Same session machinery as every other login — the gateway connects
      // and the signed-out continuation resumes via auth state. The passkey
      // was accepted, so a failure HERE is shown too, never swallowed.
      try {
        await loginWithTokens(tokens);
      } catch (err) {
        if (alive) showPasskeyError(err);
      }
    };

    void (async () => {
      try {
        if (!(await conditionalMediationAvailable())) return;
      } catch {
        return;
      }
      if (alive) await arm(0);
    })();
    return () => {
      alive = false;
      clearTimeout(refreshTimer);
      conditionalAbort.current?.abort();
      conditionalAbort.current = null;
    };
  }, [passkeysEnabled, loginWithTokens]);

  // A passkey failure moves focus to its message: the bottom button was
  // disabled while the ceremony ran (which drops focus to the page), and the
  // conditional path has no focused control of its own to return to.
  const errorRef = useRef<HTMLDivElement | null>(null);
  const focusErrorNext = useRef(false);
  useEffect(() => {
    if (error !== null && focusErrorNext.current) {
      focusErrorNext.current = false;
      errorRef.current?.focus();
    }
  }, [error]);

  function showPasskeyError(err: unknown): void {
    focusErrorNext.current = true;
    setError({ message: describePasskeyError(err), detail: null });
  }

  /** Kills a still-pending conditional ceremony — used when the user picks an
      EXPLICIT path (password submit, bottom button, a #127 step) it must not
      race. */
  function abortConditional(): void {
    conditionalAbort.current?.abort();
    conditionalAbort.current = null;
  }

  /** The step completions' shared exit: the SAME session machinery every
      other login uses (gateway connect, signed-out continuation via auth
      state), plus the post-password passkey ask — a 2FA login is still a
      password login (the code proves possession of the second factor on top
      of it, which is the whole point). */
  async function completePasswordLogin(tokens: AuthTokens): Promise<void> {
    await loginWithTokens(tokens);
    if (passkeysEnabled) markPasswordLoginForPasskeyPrompt();
  }

  /** Leave a #127 step and stand the password form back up (fresh password;
      the identifier stays — it was already accepted). */
  function backToCredentials(): void {
    setError(null);
    setTotpCode('');
    setEnrollCode('');
    setPassword('');
    setStep({ kind: 'credentials' });
  }

  /**
   * The #127 steps' error classifier. The server's own copy is authoritative
   * for its refusals: the uniform verify/confirm 401 (wrong code or dead
   * grant — indistinguishable by design) and the confirm's 400 keep the user
   * ON the step with that copy. `two_factor_disabled` (the operator flipped
   * the switch mid-flow) and `already_enrolled` (the enrollment stuck
   * elsewhere while we walked) mean the step is void — back to the password
   * form. Everything else (network, 5xx) goes through the shared classifier.
   */
  function applyStepError(err: unknown, context: string): void {
    const key = (err as { key?: string }).key;
    // 6.4 rename window: the server's keys moved to lower_snake and a
    // pre-rename bundle can still be live, so ONE case-insensitive comparison
    // covers both spellings — the idiom `isRateLimitError` already uses.
    const normalizedKey = key?.toLowerCase();
    const message = err instanceof Error && err.message ? err.message : '';
    if (normalizedKey === 'two_factor_disabled' || normalizedKey === 'already_enrolled') {
      // backToCredentials clears the error, so it runs FIRST — the server's
      // copy of why the step died must survive the transition.
      backToCredentials();
      setError({ message, detail: null });
      return;
    }
    if (normalizedKey === 'invalid_credentials' || normalizedKey === 'invalid_code') {
      setError({ message, detail: null });
      return;
    }
    setError(
      describeAuthError(err, {
        fallback: 'Could not sign in. Please try again.',
        context,
      }),
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // The user chose the password path: a still-pending conditional ceremony
    // dies NOW, so a late autofill assertion cannot land a second login over
    // this one.
    abortConditional();

    if (isDesktopShell) {
      // The server field is part of the login: validated, persisted for the
      // next launch, and applied to the live session BEFORE the credential
      // walk dials it. Its refusal is the form's OWN error (the credential
      // classifier below is about the server's answers, not the address).
      try {
        const origin = validateServerOrigin(server);
        session.setServerOrigin(origin);
        localStorage.setItem(SERVER_ORIGIN_KEY, origin);
      } catch (error) {
        setServerError(
          error instanceof ServerOriginError
            ? error.message
            : 'That server address could not be used. Check it and try again.',
        );
        setBusy(false);
        return;
      }
    }

    try {
      // #127: typed for every branch — the pair (mode off / passkey / OIDC),
      // or a challenge grant carrying a `status`.
      const res = await api.loginRaw({ identifier, password });

      if ('access_token' in res) {
        await completePasswordLogin(res);
        return;
      }

      // Past this point the password VERIFIED — failures below are the 2FA
      // walk's, so the copy comes from the server response (applyStepError),
      // never the credential classifier.
      setPassword('');
      if (res.status === 'totp_pending') {
        setStep({ kind: 'totp', grant: res.grant, username: res.user.username });
      } else {
        try {
          const start = await api.twoFactorEnrollStart(res.grant);
          setStep({
            kind: 'enroll',
            grant: res.grant,
            username: res.user.username,
            secret: start.secret,
            otpauthUri: start.otpauth_uri,
          });
        } catch (err) {
          applyStepError(err, 'login-enroll-start');
        }
      }
    } catch (err) {
      const key = (err as { key?: string }).key;
      // Known credential rejection keeps its specific copy; everything else
      // goes through the classifier (network vs generic + logged cause).
      // 6.4 rename window: one case-insensitive comparison covers both
      // spellings (see `applyStepError`).
      setError(
        key?.toLowerCase() === 'invalid_credentials'
          ? { message: 'Wrong username/email or password.', detail: null }
          : describeAuthError(err, {
              fallback: 'Could not sign in. Please try again.',
              context: 'login',
            }),
      );
    } finally {
      setBusy(false);
    }
  }

  /** The enrolled account's second factor: the grant + the code swap for the
      token pair. */
  async function onTotpSubmit(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'totp') return;
    setError(null);
    setBusy(true);
    // The ceremony was already aborted at the password submit; re-arming it
    // here is impossible (one arm per page life), so this is a cheap no-op
    // kept for the guarantee's sake: no step may race an autofill assertion.
    abortConditional();

    try {
      const tokens = await api.twoFactorVerify({ grant: step.grant, code: totpCode.trim() });
      await completePasswordLogin(tokens);
    } catch (err) {
      applyStepError(err, 'login-totp');
    } finally {
      setBusy(false);
    }
  }

  /** The forced enrollment's confirm: a valid code arms the enrollment and —
      the grant path — mints the token pair. Skipping is impossible; this is
      the walk's only exit. */
  async function onEnrollSubmit(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'enroll') return;
    setError(null);
    setBusy(true);
    abortConditional();

    try {
      const res = await api.twoFactorEnrollConfirm({
        grant: step.grant,
        code: enrollCode.trim(),
      });
      if ('access_token' in res) {
        await completePasswordLogin(res);
        return;
      }
      // The grant path always mints; a bare `{"enrolled": true}` here would
      // mean the server took the Bearer branch — impossible mid-login walk.
      // Treat it as the honest oddity it is rather than silently proceeding.
      setError({
        message: 'Two-factor was set up, but the sign-in could not be completed. Please sign in again.',
        detail: null,
      });
      backToCredentials();
    } catch (err) {
      applyStepError(err, 'login-enroll-confirm');
    } finally {
      setBusy(false);
    }
  }

  async function onPasskeySignIn() {
    setError(null);
    setPasskeyBusy(true);
    // One ceremony at a time: the explicit button supersedes any pending
    // automatic offer (browsers refuse concurrent WebAuthn requests anyway).
    abortConditional();

    try {
      const tokens = await authenticateWithPasskey(api);
      // Success: the same session machinery as password login — the gateway
      // connects and the signed-out continuation resumes via auth state.
      await loginWithTokens(tokens);
    } catch (err) {
      showPasskeyError(err);
    } finally {
      setPasskeyBusy(false);
    }
  }

  // #12 — the provider path: the server mints the ceremony, the BROWSER goes
  // to the provider (a full-page redirect; this page is done rendering for
  // now), and the provider lands on #/auth/oidc/callback to finish.
  async function onOidcSignIn() {
    setError(null);
    setOidcBusy(true);

    try {
      await startOidcSignIn(api, currentReturnTo());
    } catch (err) {
      setError(
        describeAuthError(err, {
          fallback: 'Could not start the SSO sign-in. Please try again.',
          context: 'oidc-start',
        }),
      );
      setOidcBusy(false);
    }
  }

  return (
    <div className={authPageClass} data-testid="login-page">
      <div className={authCardClass}>
        {step.kind === 'credentials' ? (
          <>
            <h1 className={authHeadingClass}>Sign in to Hrmny</h1>

            <form onSubmit={onSubmit} className="space-y-4">
            {isDesktopShell && serverError !== null && (
              <div role="alert" className={errorClass} data-testid="login-server-error">
                {serverError}
              </div>
            )}

            {isDesktopShell && (
              <div>
                <label className={labelClass} htmlFor="login-server">
                  Server
                </label>
                <input
                  id="login-server"
                  className={fieldClass}
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  inputMode="url"
                  data-testid="login-server"
                />
              </div>
            )}

            <div>
              <label className={labelClass} htmlFor="login-identifier">
                Username or email
              </label>
              <input
                id="login-identifier"
                className={fieldClass}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                // `webauthn` is what makes the browser offer the conditional
                // passkey in this field's autofill dropdown (with the automatic
                // ceremony armed below).
                autoComplete="username webauthn"
                required
              />
            </div>

            <div>
              <label className={labelClass} htmlFor="login-password">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                className={fieldClass}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            {error !== null && (
              <div
                role="alert"
                aria-live="assertive"
                tabIndex={-1}
                ref={errorRef}
                className={errorClass}
                data-testid="login-error"
              >
                {error.message}
                {error.detail !== null ? (
                  <span className="mt-1 block text-xs opacity-75" data-testid="login-error-detail">
                    {error.detail}
                  </span>
                ) : null}
              </div>
            )}

              <button type="submit" className={buttonClass} disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            {/* #36 bottom-button v1: the passkey row, beside the future SSO slot.
                Hidden entirely when the server does not offer the surface — an
                absent button is the honest "not here", and every CEREMONY failure
                (unsupported browser, cancelled prompt, server refusal) still
                lands in the shared alert above. */}
            {passkeysEnabled ? (
              <div className="mt-4 flex flex-col gap-2" data-testid="login-passkey-row">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={passkeyBusy}
                  data-testid="login-passkey-button"
                  onClick={() => {
                    void onPasskeySignIn();
                  }}
                >
                  {passkeyBusy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
                </button>
              </div>
            ) : null}

            {/* #12: the instance SSO slot — the operator's configured provider,
                labelled with the server-advertised oidc.button_label. Same
                honest-absence posture: nothing renders when the surface is off,
                and a failed START lands in the shared alert above while password
                login stays untouched (the break-glass path). The signed-out
                continuation (the current hash, #114) rides along as return_to
                because the provider redirect wipes the address. */}
            {oidcEnabled ? (
              <div className="mt-2 flex flex-col gap-2" data-testid="login-oidc-row">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={oidcBusy}
                  data-testid="login-oidc-button"
                  onClick={() => {
                    void onOidcSignIn();
                  }}
                >
                  {oidcBusy ? 'Redirecting to your provider…' : oidcLabel}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {/* #127 — the branched steps. The password verified; the card now
                walks whichever second factor this account owes. Both steps
                carry the identity the server sent for the display. */}
            <h1 className={authHeadingClass}>
              {step.kind === 'totp' ? 'Two-factor authentication' : 'Set up two-factor authentication'}
            </h1>
            <p className="-mt-4 mb-4 text-sm text-text-muted" data-testid="login-step-user">
              Signing in as @{step.username}
            </p>

            {step.kind === 'totp' ? (
              <form onSubmit={onTotpSubmit} className="space-y-4" data-testid="login-totp-step">
                <div>
                  <label className={labelClass} htmlFor="login-totp-code">
                    Enter the 6-digit code from your authenticator app.
                  </label>
                  <input
                    id="login-totp-code"
                    className={fieldClass}
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\s/g, ''))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={12}
                    data-testid="login-totp-input"
                    required
                  />
                </div>

                {error !== null && (
                  <div role="alert" className={errorClass} data-testid="login-totp-error">
                    {error.message}
                  </div>
                )}

                <button type="submit" className={buttonClass} disabled={busy || totpCode.trim() === ''}>
                  {busy ? 'Verifying…' : 'Verify'}
                </button>
              </form>
            ) : (
              <form onSubmit={onEnrollSubmit} className="space-y-4" data-testid="login-enroll-step">
                <p className="text-sm text-text-muted">
                  Your server requires two-factor authentication. Scan the QR code with an
                  authenticator app (or enter the code below it manually), then confirm with the
                  6-digit code it shows.
                </p>

                <div className="flex flex-col items-center gap-3">
                  <QrSvg
                    value={step.otpauthUri}
                    label="QR code with the two-factor setup URI — scan it with an authenticator app"
                  />
                  <span className="break-all rounded border border-line bg-surface-strong px-2 py-1 font-mono text-xs text-text" data-testid="login-enroll-secret">
                    {step.secret}
                  </span>
                </div>

                <div>
                  <label className={labelClass} htmlFor="login-enroll-code">
                    6-digit confirmation code
                  </label>
                  <input
                    id="login-enroll-code"
                    className={fieldClass}
                    value={enrollCode}
                    onChange={(e) => setEnrollCode(e.target.value.replace(/\s/g, ''))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={12}
                    data-testid="login-enroll-input"
                    required
                  />
                </div>

                {error !== null && (
                  <div role="alert" className={errorClass} data-testid="login-enroll-error">
                    {error.message}
                  </div>
                )}

                <button type="submit" className={buttonClass} disabled={busy || enrollCode.trim() === ''}>
                  {busy ? 'Verifying…' : 'Confirm'}
                </button>
              </form>
            )}

            <button
              type="button"
              className={ghostButtonClass + ' mt-4'}
              onClick={backToCredentials}
              data-testid="login-step-back"
            >
              Back to sign in
            </button>
          </>
        )}

        <div className="mt-4 flex justify-between text-sm">
          <button
            type="button"
            className="rounded text-accent transition-colors duration-[var(--duration-control)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            onClick={() => onNavigate?.('/forgot-password')}
          >
            Forgot password?
          </button>
          <button
            type="button"
            className="rounded text-accent transition-colors duration-[var(--duration-control)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
            onClick={() => onNavigate?.('/register')}
          >
            Create an account
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The last /auth/methods answer (lane D #4)
// ---------------------------------------------------------------------------

/** Per-origin cache key: a different server offers different doors. */
function authMethodsKey(): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `cytale.auth-methods.${origin}`;
}

interface CachedAuthMethods {
  webauthn?: boolean;
  oidc?: boolean;
  oidc_button_label?: string | null;
}

/**
 * The login surfaces the server offered last time, or null. A hint only —
 * the live read below always replaces it — so a stale value costs at most a
 * button that appears and then goes, never a door that is really closed.
 */
function readCachedAuthMethods(): CachedAuthMethods | null {
  try {
    const raw = localStorage.getItem(authMethodsKey());
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as CachedAuthMethods) : null;
  } catch {
    return null;
  }
}

function writeCachedAuthMethods(methods: CachedAuthMethods): void {
  try {
    localStorage.setItem(
      authMethodsKey(),
      JSON.stringify({
        webauthn: methods.webauthn === true,
        oidc: methods.oidc === true,
        oidc_button_label: typeof methods.oidc_button_label === 'string' ? methods.oidc_button_label : null,
      }),
    );
  } catch {
    // storage unavailable — the next visit reads the server again
  }
}
