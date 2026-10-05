/**
 * @cytale/mobile — sign in (plan 004 M12, R4/R6).
 *
 * The fresh-install destination: username-or-email + password, exactly web's
 * `LoginPage` fields and copy. `session.login()` owns the whole exchange
 * (tokens, proactive refresh, /users/@me, gateway connect) — this screen only
 * renders its states:
 *
 *   busy    → the submit control announces "Signing in…"
 *   error   → the server's meaning inline (`describeAuthFailure`)
 *   offline → the connectivity state with a retry of the last attempt
 *   notice  → why this screen is showing (expired/revoked session, sign-out)
 *
 * On success the ROOT gate navigates: a deep link captured before sign-in
 * resumes, otherwise the drawer (or the verification gate for a new account).
 */
import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';

import { ServerOriginError, validateServerOrigin } from '@cytale/session';

import { useSession } from '../../src/navigation/session';
import { describeAuthFailure, type AuthFailure } from '../../src/auth/errors';
import { AUTH_ROUTES } from '../../src/auth/routes';
import { useSessionNotice } from '../../src/auth/sessionNotice';
import { markFreshSignIn } from '../../src/auth/verificationGate';
import { DEFAULT_SERVER_ORIGIN, readServerOrigin, writeServerOrigin } from '../../src/auth/serverOrigin';
import { AuthButton, AuthError, AuthField, AuthLink, AuthNotice, AuthScreen } from '../../src/auth/ui';

export default function SignInScreen() {
  const session = useSession();
  const notice = useSessionNotice();

  const [server, setServer] = useState(DEFAULT_SERVER_ORIGIN);
  const [serverError, setServerError] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);
  /** The attempt a connectivity retry replays (the user must not retype). */
  const lastAttempt = useRef<{ identifier: string; password: string } | null>(null);

  // The last-used server becomes the field's starting value (the default is
  // the product's own home); one async read on mount, best effort.
  useEffect(() => {
    let alive = true;
    void readServerOrigin().then((stored) => {
      if (alive && stored) setServer(stored);
    });
    return () => {
      alive = false;
    };
  }, []);

  const signIn = async (attempt: { identifier: string; password: string }) => {
    setBusy(true);
    setFailure(null);
    lastAttempt.current = attempt;
    try {
      await session.login(attempt.identifier, attempt.password);
      // A user-performed sign-in: the root gate decides where to land, and an
      // unverified account meets R6's verification gate rather than a shell
      // where every send would fail.
      markFreshSignIn();
    } catch (error) {
      setFailure(describeAuthFailure(error, 'sign-in'));
    } finally {
      setBusy(false);
    }
  };

  /** Applies the server field BEFORE the credential walk: the session
      re-points (validated, persisted), then the login dials it. */
  const submit = async (attempt: { identifier: string; password: string }) => {
    try {
      const origin = validateServerOrigin(server, { dev: __DEV__ });
      session.setServerOrigin(origin, { dev: __DEV__ });
      void writeServerOrigin(origin);
    } catch (error) {
      setServerError(
        error instanceof ServerOriginError
          ? error.message
          : 'That server address could not be used. Check it and try again.',
      );
      return;
    }
    await signIn(attempt);
  };

  const canSubmit = identifier !== '' && password !== '' && !busy;

  return (
    <AuthScreen testID="surface-sign-in" title="Sign in to Hrmny">
      {notice === null ? null : (
        <AuthNotice message={notice.message} testID="sign-in-notice" />
      )}

      <AuthField
        label="Server"
        testID="sign-in-server"
        value={server}
        onChangeText={setServer}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textContentType="URL"
        returnKeyType="next"
      />

      <AuthField
        label="Username or email"
        testID="sign-in-identifier"
        value={identifier}
        onChangeText={setIdentifier}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        returnKeyType="next"
      />

      <AuthField
        label="Password"
        testID="sign-in-password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => {
          if (canSubmit) void signIn({ identifier, password });
        }}
      />

      {failure === null ? null : failure.kind === 'offline' ? (
        <>
          <AuthError message={failure.message} testID="sign-in-offline" />
          <AuthButton
            label="Try again"
            testID="sign-in-retry"
            busy={busy}
            busyLabel="Trying again…"
            disabled={lastAttempt.current === null}
            onPress={() => {
              const attempt = lastAttempt.current;
              if (attempt !== null) void signIn(attempt);
            }}
          />
        </>
      ) : (
        <AuthError message={failure.message} testID="sign-in-error" />
      )}

      {serverError !== null && (
        <AuthError message={serverError} testID="sign-in-server-error" />
      )}

      <AuthButton
        label="Sign in"
        busyLabel="Signing in…"
        testID="sign-in-submit"
        busy={busy}
        disabled={!canSubmit}
        onPress={() => void submit({ identifier, password })}
      />

      <AuthLink
        label="Create an account"
        testID="sign-in-create-account"
        onPress={() => router.push(AUTH_ROUTES.signUp as never)}
      />
    </AuthScreen>
  );
}
