/**
 * @cytale/mobile — UserPanel, the drawer's identity footer (plan 004 M5).
 *
 * The bottom-left identity block ported to the drawer: avatar + presence dot,
 * name + handle, and the settings gear that opens the settings surface. Log
 * out lives in settings as its final row (R14), never here.
 *
 * Reads the signed-in identity from the state store's `currentUser` (the
 * gateway's truth). Renders nothing when nobody is signed in — the shell
 * around it still works.
 */
import { useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Feather } from '@expo/vector-icons';

import { theme } from '../theme';
import { settingsHref } from './routes';
import { serverAssetUrl, getSessionManager } from './session';
import { useShell } from './ShellContext';
import { useStoreSelector } from './store';
import { Avatar, MIN_TOUCH_TARGET } from './ui';

export function UserPanel() {
  const { store, navigate, closeDrawer } = useShell();
  // The AUTH user is the avatar's source (the /users/@me payload carries the
  // avatar_url; the gateway store's self user may not). Falls back to the
  // gateway store's value when the auth user has none. The registered-manager
  // singleton keeps standalone renders (tests) provider-free — there the
  // gateway fallback applies and the tile shows initials.
  const manager = getSessionManager();
  const authUser = useSyncExternalStore(
    manager ? manager.authStore.subscribe : () => () => {},
    () => manager?.authStore.getState().currentUser ?? null,
  );
  // The panel's BACKGROUND stays flush with the screen's bottom edge (the
  // device curve lives there) — the insets pad the CONTENTS instead, so the
  // avatar/handle shift inward without lifting the box off the edge.
  const insets = useSafeAreaInsets();
  const currentUser = useStoreSelector(store, (state) => state.currentUser);
  const presence = useStoreSelector(store, (state) =>
    currentUser === null ? undefined : state.presenceByUser[currentUser.id],
  );

  if (currentUser === null) return null;

  const status = presence?.status ?? 'online';

  return (
    <View
      style={[
        styles.panel,
        {
          paddingLeft: theme.spacing.md + insets.left,
          paddingRight: theme.spacing.md + insets.right,
          paddingBottom: theme.spacing.sm + insets.bottom,
        },
      ]}
      testID="user-panel"
    >
      <View
        accessibilityRole="image"
        accessibilityLabel={`${currentUser.username} — ${presenceLabel(status)}`}
        testID="user-panel-identity"
      >
        <Avatar
          id={currentUser.id}
          name={currentUser.username}
          status={status}
          size={32}
          imageUrl={serverAssetUrl(currentUser?.avatar_url ?? authUser?.avatar_url ?? null)}
        />
      </View>
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1}>
          {currentUser.username}
        </Text>
        <Text style={styles.handle} numberOfLines={1}>
          {`@${currentUser.username}`}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="User settings"
        onPress={() => {
          navigate(settingsHref());
          closeDrawer();
        }}
        testID="user-panel-settings"
        style={({ pressed }) => [styles.gear, pressed ? styles.gearPressed : null]}
      >
        <Feather name="settings" size={18} color={theme.colors.textMuted} />
      </Pressable>
    </View>
  );
}

function presenceLabel(status: 'online' | 'idle' | 'dnd' | 'offline'): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'idle':
      return 'Idle';
    case 'dnd':
      return 'Do not disturb';
    default:
      return 'Offline';
  }
}

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceStrong,
  },
  identity: {
    flex: 1,
  },
  name: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.md,
    fontWeight: '700',
  },
  handle: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
  gear: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radii.md,
  },
  gearPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  gearGlyph: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.lg,
  },
});
