/**
 * @cytale/mobile — AccountSection (plan 004 M10, R14/R15).
 *
 * The gear surface's Account section, carried as far as the server substrate
 * honestly supports (mirrors web's `AccountSection`, audited 2026-09-06):
 *
 *   - Identity rows are real reads of `GET /users/@me`; username and email are
 *     read-only (no change-email endpoint exists — nothing fakes editability).
 *   - `display_name` is the field `PATCH /users/@me` accepts; saving it
 *     converges the auth store and the caller's roster row (web's exact
 *     convergence) so member lists update without a refetch.
 *   - "Password" is the reset-email flow: no authenticated change-password
 *     endpoint exists, and completing the reset revokes every session — the
 *     same protective posture.
 *   - Sessions: refresh tokens store only hash + expiry, so there is no device
 *     LIST to fake — the real action is `DELETE /users/@me/sessions` (sign out
 *     everywhere, this device included), followed by the local logout.
 *
 * Destructive actions use an inline two-step confirm, never an OS alert.
 * States-first: the identity fetch renders loading / error+retry / content.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { theme } from '../theme';
import { Avatar } from '../navigation/ui';
import { ErrorState, LoadingState, PermissionDenied } from '../navigation/SurfaceStates';
import { errorMessage, isPermissionDenied } from './errors';
import { convergeRoster, isVerified, unwrapUser } from './profile';
import { useCurrentUser, type SettingsServices } from './services';
import { ActionButton, DetailRow, Field, SectionHeading, settingsStyles } from './ui';
import { buildVersion, clientErrors } from '../observability/clientErrors';

export interface AccountSectionProps {
  services: SettingsServices;
}

type LoadStatus = 'loading' | 'error' | 'denied' | 'ready';

export function AccountSection({ services }: AccountSectionProps) {
  const { api, session, store } = services;
  const authStore = session.authStore;
  const user = useCurrentUser(authStore);

  // -- identity load ---------------------------------------------------------
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  // Diagnostics-only (EXPO_PUBLIC_CYTALE_DIAGNOSTICS builds): how many test
  // errors this session has fired, for the button's own feedback.
  const [fired, setFired] = useState(0);

  const load = useCallback(() => {
    setStatus('loading');
    setLoadError(null);
    void api.getCurrentUser().then(
      (response) => {
        const fresh = unwrapUser(response);
        if (fresh !== null) authStore.getState().setUser(fresh);
        setStatus('ready');
      },
      (error: unknown) => {
        setLoadError(errorMessage(error, 'Could not load your account. Please try again.'));
        setStatus(isPermissionDenied(error) ? 'denied' : 'error');
      },
    );
  }, [api, authStore]);

  useEffect(() => {
    load();
  }, [load]);

  // -- profile form ----------------------------------------------------------
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed the draft when the underlying user changes (post-save refresh).
  useEffect(() => {
    setDraft(user?.display_name ?? '');
  }, [user?.display_name]);

  const dirty = draft !== (user?.display_name ?? '');
  const savedVisible = savedName !== null && saveError === null && savedName === draft;

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const response = await api.updateCurrentUser({ display_name: draft });
      const fresh = unwrapUser(response);
      if (fresh !== null) authStore.getState().setUser(fresh);
      convergeRoster(store, fresh?.id ?? user?.id, draft);
      setSavedName(draft);
    } catch (error) {
      setSaveError(errorMessage(error, 'Could not save. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  // -- password reset --------------------------------------------------------
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const handleReset = async () => {
    const email = user?.email ?? null;
    if (email === null || email === '') return;
    setResetError(null);
    try {
      await api.requestPasswordReset(email);
      setResetSent(true);
    } catch (error) {
      setResetError(errorMessage(error, 'Could not send the reset email. Please try again.'));
    }
  };

  // -- sign out everywhere ---------------------------------------------------
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOutEverywhere = async () => {
    setSigningOut(true);
    try {
      try {
        await api.revokeAllSessions();
      } catch {
        // Best-effort revoke: the local teardown happens regardless, exactly
        // as the reset flow's posture has it.
      }
      await session.logout('You were signed out on all devices.');
    } finally {
      setSigningOut(false);
      setConfirmingSignOut(false);
    }
  };

  if (status === 'loading') {
    return <LoadingState label="Loading your account…" />;
  }

  if (status === 'denied') {
    return <PermissionDenied message={loadError ?? 'You cannot view this account.'} />;
  }

  if (status === 'error') {
    return (
      <View style={settingsStyles.section}>
        <ErrorState message={loadError ?? 'Could not load your account. Please try again.'} />
        <ActionButton label="Retry" onPress={load} testID="account-retry" />
      </View>
    );
  }

  const displayName = user?.display_name || user?.username || '…';
  const verified = isVerified(user);

  return (
    <View style={settingsStyles.section} testID="settings-account">
      <View style={settingsStyles.card}>
        <View style={styles.identity}>
          <Avatar id={user?.id ?? '?'} name={displayName} size={64} decorative={false} />
          <View style={styles.identityText}>
            <Text style={styles.identityName} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.identityHandle} numberOfLines={1}>
              @{user?.username ?? '…'}
            </Text>
          </View>
        </View>

        <DetailRow label="Username">
          <Text style={styles.detail} testID="account-username">
            {user?.username ?? '…'}
          </Text>
        </DetailRow>

        <DetailRow label="Email">
          <View style={styles.emailRow}>
            <Text style={styles.detail} testID="account-email">
              {user?.email ?? '…'}
            </Text>
            {verified ? (
              <Text style={styles.verified} testID="account-verified">
                Verified
              </Text>
            ) : (
              <Text style={styles.unverified} testID="account-unverified">
                Unverified
              </Text>
            )}
          </View>
        </DetailRow>

        <DetailRow label="Member since">
          <Text style={styles.detail} testID="account-created">
            {user?.created_at ? new Date(user.created_at).toLocaleDateString() : '…'}
          </Text>
        </DetailRow>
      </View>

      <View style={styles.block}>
        <SectionHeading>Profile</SectionHeading>
        <Field
          label="Display name"
          hint="Shown instead of your username where Hrmny displays you."
        >
          <TextInput
            style={styles.input}
            value={draft}
            maxLength={100}
            placeholder={user?.username ?? ''}
            placeholderTextColor={theme.colors.textMuted}
            onChangeText={setDraft}
            accessibilityLabel="Display name"
            testID="account-display-name"
          />
        </Field>

        {saveError === null ? null : (
          <Text style={settingsStyles.errorText} role="alert" accessibilityRole="alert" testID="account-save-error">
            {saveError}
          </Text>
        )}

        <View style={styles.saveRow}>
          <ActionButton
            label={saving ? 'Saving…' : 'Save changes'}
            variant="primary"
            disabled={!dirty || saving}
            onPress={() => {
              void handleSave();
            }}
            testID="account-save"
          />
          {savedVisible ? (
            <Text style={settingsStyles.statusText} role="status" testID="account-saved">
              Saved.
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.block}>
        <SectionHeading>Password</SectionHeading>
        <Text style={settingsStyles.bodyText}>
          Password changes ride the reset flow: we email a link to your address, and completing it
          signs out every device.
        </Text>
        {resetError === null ? null : (
          <Text style={settingsStyles.errorText} role="alert" accessibilityRole="alert" testID="account-reset-error">
            {resetError}
          </Text>
        )}
        {resetSent ? (
          <Text style={settingsStyles.statusText} role="status" testID="account-reset-sent">
            Reset link sent — check your inbox.
          </Text>
        ) : (
          <ActionButton
            label="Send password reset email"
            disabled={!user?.email}
            onPress={() => {
              void handleReset();
            }}
            testID="account-send-reset"
            style={styles.selfStart}
          />
        )}
      </View>

      <View style={styles.block}>
        <SectionHeading>Sessions</SectionHeading>
        <Text style={settingsStyles.bodyText}>
          You are signed in here. Sessions are 30-day rotating refresh tokens — signing out
          everywhere revokes all of them, including this one, and closes live connections.
        </Text>
        {confirmingSignOut ? (
          <View style={settingsStyles.confirm} testID="account-signout-confirm">
            <Text style={styles.confirmText}>
              Sign out on every device, including this one?
            </Text>
            <View style={settingsStyles.confirmRow}>
              <ActionButton
                label="Cancel"
                onPress={() => setConfirmingSignOut(false)}
                testID="account-signout-cancel"
              />
              <ActionButton
                label={signingOut ? 'Signing out…' : 'Sign out everywhere'}
                variant="danger"
                disabled={signingOut}
                onPress={() => {
                  void handleSignOutEverywhere();
                }}
                testID="account-signout-confirm-yes"
              />
            </View>
          </View>
        ) : (
          <ActionButton
            label="Sign out everywhere"
            onPress={() => setConfirmingSignOut(true)}
            testID="account-signout-everywhere"
            style={styles.selfStart}
          />
        )}
      </View>
      {process.env.EXPO_PUBLIC_CYTALE_DIAGNOSTICS === '1' ? (
        <View style={styles.diagnostics}>
          <SectionHeading>Diagnostics</SectionHeading>
          <Text style={styles.diagnosticsNote}>
            Test-build only (#88 on-device check). Fires one deliberate client
            error through the real capture pipeline. It is deduped per session:
            tap once, restart the app, tap again — three rounds in a window
            trip the admin alert.
          </Text>
          <ActionButton
            label={fired > 0 ? `Fired test error (this session: ${fired})` : 'Fire test client error'}
            onPress={() => {
              clientErrors.captureThrown(
                new Error('hrmny diagnostics: deliberate test error (#88 on-device check)'),
                { source: 'error-boundary' },
              );
              setFired((n) => n + 1);
            }}
            testID="account-diagnostics-fire"
            style={styles.selfStart}
          />
          <Text style={styles.diagnosticsNote}>build {buildVersion()}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  identityText: {
    flexShrink: 1,
  },
  identityName: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.xl,
    fontWeight: '600',
  },
  identityHandle: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.md,
  },
  detail: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.md,
  },
  emailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  verified: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.full,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  unverified: {
    color: theme.colors.warning,
    fontSize: theme.fontSizes.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.warning,
    borderRadius: theme.radii.full,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  block: {
    gap: theme.spacing.md,
  },
  input: {
    minHeight: 44,
    borderRadius: theme.radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.inputBorder,
    backgroundColor: theme.colors.input,
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
    paddingHorizontal: theme.spacing.md,
  },
  saveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  confirmText: {
    color: theme.colors.warning,
    fontSize: theme.fontSizes.md,
  },
  selfStart: {
    alignSelf: 'flex-start',
  },
  diagnostics: {
    gap: theme.spacing.md,
    marginTop: theme.spacing.lg,
  },
  diagnosticsNote: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
  },
});
