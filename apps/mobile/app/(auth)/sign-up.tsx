/**
 * @cytale/mobile — create an account (plan 004 M12, R4/R6).
 *
 * Web's `RegisterPage`, natively: username + email + password, the taken-name
 * copy inline, and the honest note that accounts start view-only. On success
 * `session.register()` signs the account in, and the root gate sends the
 * unverified member to the verification screen (R6's gate) rather than into
 * the drawer where every send would fail.
 */
import { useState } from 'react';
import { router } from 'expo-router';

import { useSession } from '../../src/navigation/session';
import { describeAuthFailure, type AuthFailure } from '../../src/auth/errors';
import { AUTH_ROUTES } from '../../src/auth/routes';
import { markFreshSignIn } from '../../src/auth/verificationGate';
import { AuthButton, AuthError, AuthField, AuthLink, AuthScreen } from '../../src/auth/ui';

export default function SignUpScreen() {
  const session = useSession();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const createAccount = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await session.register(username, email, password);
      // A fresh account is unverified: the root gate routes it to the
      // verification screen instead of a shell where sends would fail.
      markFreshSignIn();
    } catch (error) {
      setFailure(describeAuthFailure(error, 'sign-up'));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = username !== '' && email !== '' && password !== '' && !busy;

  return (
    <AuthScreen
      testID="surface-sign-up"
      title="Create your account"
      subtitle="Accounts start view-only — verify your email to post."
    >
      <AuthField
        label="Username"
        testID="sign-up-username"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username-new"
        textContentType="username"
      />

      <AuthField
        label="Email"
        testID="sign-up-email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
      />

      <AuthField
        label="Password"
        testID="sign-up-password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        onSubmitEditing={() => {
          if (canSubmit) void createAccount();
        }}
      />

      {failure === null ? null : failure.kind === 'offline' ? (
        <>
          <AuthError message={failure.message} testID="sign-up-offline" />
          <AuthButton
            label="Try again"
            testID="sign-up-retry"
            busy={busy}
            busyLabel="Trying again…"
            onPress={() => void createAccount()}
          />
        </>
      ) : (
        <AuthError message={failure.message} testID="sign-up-error" />
      )}

      <AuthButton
        label="Create account"
        busyLabel="Creating…"
        testID="sign-up-submit"
        busy={busy}
        disabled={!canSubmit}
        onPress={() => void createAccount()}
      />

      <AuthLink
        label="Back to sign in"
        testID="sign-up-sign-in"
        onPress={() => router.replace(AUTH_ROUTES.signIn as never)}
      />
    </AuthScreen>
  );
}
