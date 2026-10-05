/**
 * @cytale/mobile — IntegrationsSection (plan 004 M10, R14/R15).
 *
 * The owner's centralized observe rollup: every machine principal the caller
 * parents — bots and agents, across ALL workspaces in one read of
 * `GET /users/@me/integrations` — with a live-session dot. Read-only observe
 * (R14): lifecycle actions (rename, rotate, revoke, and the access tree) live
 * in the WEB client's user settings, under `#/settings/integrations`, which is
 * the one management surface (plan 2026-09-15-1200, KD1). This rollup carries
 * no duplicate affordances, and there is no longer a dedicated Integrations
 * overlay to jump to.
 *
 * Webhooks are parent-owned capability rows, NOT workspace-scoped ones: they
 * are the caller's own, they are managed under `#/settings/webhooks` on the
 * web, and they appear in this feed as rows like any other principal.
 *
 * States-first: loading, error + retry, empty, content.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { MyIntegration } from '@cytale/api-client';

import { theme } from '../theme';
import { ErrorState, LoadingState, PermissionDenied } from '../navigation/SurfaceStates';
import { errorMessage, isPermissionDenied } from './errors';
import type { SettingsServices } from './services';
import { ActionButton, settingsStyles } from './ui';

export interface IntegrationsSectionProps {
  services: SettingsServices;
}

const KIND_LABEL: Record<MyIntegration['kind'], string> = {
  bot: 'Bot',
  agent: 'Agent',
  webhook: 'Webhook',
};

type Status = 'loading' | 'error' | 'denied' | 'ready';

export function IntegrationsSection({ services }: IntegrationsSectionProps) {
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<MyIntegration[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setStatus('loading');
    setError(null);
    void services.api.listMyIntegrations().then(
      (rows) => {
        setItems(rows);
        setStatus('ready');
      },
      (cause: unknown) => {
        setError(errorMessage(cause, 'Could not load your integrations. Please try again.'));
        setStatus(isPermissionDenied(cause) ? 'denied' : 'error');
      },
    );
  }, [services.api]);

  useEffect(() => {
    load();
  }, [load]);

  if (status === 'loading') {
    return <LoadingState label="Loading your integrations…" />;
  }

  if (status === 'denied') {
    return <PermissionDenied message={error ?? 'You cannot view these integrations.'} />;
  }

  if (status === 'error') {
    return (
      <View style={settingsStyles.section}>
        <ErrorState message={error ?? 'Could not load your integrations. Please try again.'} />
        <ActionButton label="Retry" onPress={load} testID="integrations-retry" />
      </View>
    );
  }

  return (
    <View style={settingsStyles.section} testID="settings-integrations">
      <Text style={settingsStyles.bodyText}>
        Every credential that acts for you — bots (workspace automations) and agents (personal
        credentials) across all your workspaces. Managing one (rename, rotate, revoke) happens in
        the Integrations surface.
      </Text>

      {items.length === 0 ? (
        <View style={settingsStyles.card} testID="integrations-empty">
          <Text style={settingsStyles.bodyText}>
            No integrations yet. Bots are minted per workspace; agents are yours directly — both
            start from the Integrations surface.
          </Text>
        </View>
      ) : (
        <View style={styles.list} testID="integrations-list">
          {items.map((item) => (
            <View
              key={item.id}
              style={styles.row}
              testID={`integration-row-${item.id}`}
              accessibilityLabel={`${item.name ?? `Unnamed ${KIND_LABEL[item.kind]}`}, ${
                KIND_LABEL[item.kind]
              }, ${item.online ? 'online' : 'offline'}`}
            >
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor: item.online
                      ? theme.colors.presenceOnline
                      : theme.colors.presenceOffline,
                  },
                ]}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
              <Text style={styles.name} numberOfLines={1}>
                {item.name ?? `Unnamed ${KIND_LABEL[item.kind]}`}
              </Text>
              <Text style={styles.kind}>{KIND_LABEL[item.kind]}</Text>
              {item.created_at === null ? null : (
                <Text style={styles.date}>{new Date(item.created_at).toLocaleDateString()}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      <Text style={styles.footnote}>
        Webhooks (incoming channel URLs) are channel-scoped — they live in each channel's
        settings, not here.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: theme.spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    minHeight: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  name: {
    flexShrink: 1,
    flexGrow: 1,
    color: theme.colors.text,
    fontSize: theme.fontSizes.md,
    fontWeight: '600',
  },
  kind: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.full,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  date: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
  footnote: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
});
