/**
 * @cytale/mobile — email verification: token landing and pending gate (plan
 * 004 M12, R4/R6).
 *
 * Two jobs, web's `VerifyEmailPage` split by how the user got here:
 *
 *   * `/verify-email?token=…` (the emailed link) consumes the single-use token
 *     through `session.verifyEmail()` and reports the outcome;
 *   * a signed-in but unverified member is SENT here by the root gate. That is
 *     R6's "verification gate": the resend action is one tap away, and the
 *     member may continue read-only (web's semantics — the shell's view-only
 *     state still enforces it) instead of being trapped.
 *
 * No session logic lives here: verify/resend are the manager's existing calls.
 */
import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';

import { useAuthStatus, useSession } from '../../src/navigation/session';
import { ROUTES } from '../../src/navigation/routes';
import { isVerified, useAuthUser } from '../../src/auth/authState';
import { AUTH_ROUTES } from '../../src/auth/routes';
import { dismissVerificationGate } from '../../src/auth/verificationGate';
import { AuthButton, AuthError, AuthLink, AuthNotice, AuthScreen } from '../../src/auth/ui';

type TokenPhase = 'idle' | 'working' | 'done' | 'error';

export default function VerifyEmailScreen() {
  const session = useSession();
  const status = useAuthStatus();
  const user = useAuthUser(session);
  const params = useLocalSearchParams<{ token?: string | string[] }>();

  const rawToken = params.token;
  const token = Array.isArray(rawToken) ? (rawToken[0] ?? null) : (rawToken ?? null);

  const [phase, setPhase] = useState<TokenPhase>(token === null ? 'idle' : 'working');
  const [message, setMessage] = useState<string | null>(null);
  const [resend, setResend] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  const signedIn = status === 'authenticated';
  const verified = isVerified(user) || phase === 'done';

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;

    session
      .verifyEmail(token)
      .then(() => {
        if (!cancelled) setPhase('done');
      })
      .catch(() => {
        if (cancelled) return;
        setPhase('error');
        setMessage('This link is invalid or was already used. Send a new email below.');
      });

    return () => {
      cancelled = true;
    };
  }, [token, session]);

  const onResend = async () => {
    setResend('busy');
    try {
      await session.resendVerification();
      setResend('done');
    } catch {
      setResend('error');
      setMessage('Could not resend the email. Try again shortly.');
    }
  };

  return (
    <AuthScreen
      testID="surface-verify-email"
      title="Verify your email"
      subtitle={
        verified
          ? 'Your account is unlocked.'
          : 'Your account is view-only until verification completes.'
      }
    >
      {phase === 'working' ? <AuthNotice message="Verifying…" testID="verify-email-working" /> : null}

      {phase === 'done' ? (
        <AuthNotice
          message={
            signedIn
              ? 'Email verified — your account is unlocked. Welcome aboard.'
              : 'Email verified — sign in to continue.'
          }
          testID="verify-email-done"
        />
      ) : null}

      {phase === 'error' ? (
        <AuthError message={message ?? 'Verification failed.'} testID="verify-email-error" />
      ) : null}

      {verified ? null : (
        <>
          <AuthNotice
            message="You can browse, but posting is disabled until your email is verified."
            testID="verify-email-view-only"
          />

          {resend === 'done' ? (
            <AuthNotice
              message="Fresh verification email sent — the old link is now invalid."
              testID="verify-email-resent"
            />
          ) : (
            <>
              {signedIn ? null : (
                <AuthNotice
                  message="Sign in to resend the verification email."
                  testID="verify-email-sign-in-hint"
                />
              )}
              <AuthButton
                label="Resend verification email"
                busyLabel="Sending…"
                testID="verify-email-resend"
                busy={resend === 'busy'}
                disabled={!signedIn}
                onPress={() => void onResend()}
              />
            </>
          )}

          {resend === 'error' && message !== null ? (
            <AuthError message={message} testID="verify-email-resend-error" />
          ) : null}

          {signedIn ? (
            <AuthButton
              label="Continue read-only"
              testID="verify-email-continue"
              tone="quiet"
              onPress={() => {
                // Acknowledge the gate, then leave this screen; the root gate
                // resumes a deep link captured before sign-in if there is one.
                dismissVerificationGate();
                router.replace(ROUTES.home as never);
              }}
            />
          ) : null}
        </>
      )}

      {verified && signedIn ? (
        <AuthLink
          label="Continue to the app"
          testID="verify-email-open-app"
          onPress={() => router.replace(ROUTES.home as never)}
        />
      ) : null}

      {verified || signedIn ? null : (
        <AuthLink
          label="Back to sign in"
          testID="verify-email-sign-in"
          onPress={() => router.replace(AUTH_ROUTES.signIn as never)}
        />
      )}
    </AuthScreen>
  );
}
