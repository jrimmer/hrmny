/**
 * @cytale/mobile — SurfaceScaffold, the states-first frame every surface uses
 * (plan 004 M5, R15).
 *
 * One title bar (R7), one offline banner, one body that renders exactly one
 * of loading / error / permission-denied / empty / content, plus the
 * view-only notice under content. Screens supply their own body; the state
 * vocabulary and the announcement roles are the shell's.
 */
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { theme } from '../theme';
import { useSurfaceStates, type SurfaceStates } from './shellState';
import { EmptyState, ErrorState, LoadingState, OfflineBanner, PermissionDenied, ViewOnlyNotice } from './SurfaceStates';
import { TitleBar } from './TitleBar';

export interface SurfaceScaffoldProps {
  /** Test id for the surface root — one per surface, asserted by tests. */
  testID: string;
  title: string;
  subtitle?: string;
  onOpenDrawer?: () => void;
  onBack?: () => void;
  onOpenMembers?: () => void;
  membersLabel?: string;
  /** A surface-owned title-bar control (the channel notification button). */
  headerAction?: ReactNode;
  /**
   * Explicit states. Omitted → the shell's shared surface states. Surfaces
   * that derive their own (channel: channel missing / no messages) merge
   * before passing.
   */
  states?: SurfaceStates;
  /** Shown when the surface is empty. */
  emptyTitle?: string;
  emptyHint?: string;
  /** True when the body scrolls as a whole (settings list); default false. */
  scroll?: boolean;
  children?: ReactNode;
}

export function SurfaceScaffold({
  testID,
  title,
  subtitle,
  onOpenDrawer,
  onBack,
  onOpenMembers,
  membersLabel,
  headerAction,
  states,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  scroll = false,
  children,
}: SurfaceScaffoldProps) {
  const shared = useSurfaceStates();
  const resolved = states ?? shared;
  // The app-wide REST-bootstrap failure is rendered only by surfaces that
  // take the shared states verbatim (Home/Integrations/Diagnostics): a
  // surface with its own `states` — settings, the channel — keeps its own
  // truth and must not be blanked by a workspace-graph failure it can render
  // without. The drawer renders the same pair for the channel list.
  const hydrationError = states === undefined ? shared.hydrationError : null;

  const body = (() => {
    if (resolved.loading) return <LoadingState label={`Loading ${title}…`} />;
    if (resolved.permissionDenied) return <PermissionDenied message={resolved.permissionDenied} />;
    if (resolved.error) return <ErrorState message={resolved.error} />;
    if (hydrationError) {
      return <ErrorState message={hydrationError} onRetry={shared.retryHydration ?? undefined} />;
    }
    if (resolved.empty) return <EmptyState title={emptyTitle} hint={emptyHint} />;
    return (
      <>
        <View style={styles.content} testID={`${testID}-body`}>
          {children}
        </View>
        {resolved.viewOnly ? <ViewOnlyNotice /> : null}
      </>
    );
  })();

  const content = (
    <>
      {resolved.offline ? <OfflineBanner /> : null}
      {body}
    </>
  );

  return (
    <View style={styles.screen} testID={testID}>
      <TitleBar
        title={title}
        subtitle={subtitle}
        onOpenDrawer={onOpenDrawer}
        onBack={onBack}
        onOpenMembers={onOpenMembers}
        membersLabel={membersLabel}
        headerAction={headerAction}
      />
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollBody} testID={`${testID}-scroll`}>
          {content}
        </ScrollView>
      ) : (
        <View style={styles.body}>{content}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  body: {
    flex: 1,
  },
  scrollBody: {
    flexGrow: 1,
  },
  content: {
    flex: 1,
  },
});
