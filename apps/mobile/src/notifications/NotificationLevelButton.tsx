/**
 * @cytale/mobile — the title bar's notification control (notification
 * controls, 2026-09-27; web's `NotificationLevelControl`, native).
 *
 *   tap         cycles bell (All messages) → @ (Mentions only) → bell-off
 *               (Nothing) → bell, writing an explicit row for this channel
 *   long-press  opens a bottom sheet with all four options — the three
 *               levels and "Use workspace default" (a DM: "Use default") —
 *               as a radio group
 *
 * The data is `@cytale/state`'s shared preference slice, the same one web
 * reads, with the same optimistic write and rollback; the words are the
 * state package's too, so a level is named identically on every client. The
 * sheet is the message actions sheet's native idiom (a transparent `Modal`,
 * a tap-to-dismiss scrim, 44pt rows, a Close row for VoiceOver — which has no
 * swipe-down gesture).
 *
 * While the channel INHERITS (no row of its own) the glyph renders in the
 * muted tone, and the accessible name says where the level comes from:
 * "Notifications: Mentions only (workspace default) — tap for Nothing".
 * After a tap the new state is announced (the platform announcement, plus a
 * polite live text under the sheet idiom's status line).
 */
import { useCallback, useState } from 'react';
import { AccessibilityInfo, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Feather } from '@expo/vector-icons';

import {
  clearNotificationLevel,
  nextNotificationLevel,
  NOTIFICATION_LEVEL_LABEL,
  notificationControlLabel,
  notificationResetLabel,
  resolveNotificationTarget,
  setNotificationLevel,
  type NotificationLevel,
  type NotificationPrefsApi,
  type NotificationTarget,
  type NotificationTargetView,
  type StateStore,
} from '@cytale/state';

import { MIN_TOUCH_TARGET } from '../navigation/ui';
import { useStoreSelector, type StoreLike } from '../navigation/store';
import { theme } from '../theme';

/** The Feather glyph a level is drawn with (bell / at-sign / bell-off, as on web). */
export function levelGlyph(level: NotificationLevel): 'bell' | 'at-sign' | 'bell-off' {
  if (level === 'all') return 'bell';
  if (level === 'mentions') return 'at-sign';
  return 'bell-off';
}

export interface NotificationLevelButtonProps {
  target: NotificationTarget;
  store: StoreLike;
  api: NotificationPrefsApi;
  /** Names the target in the sheet's title ("#general"). */
  targetName?: string;
  testID?: string;
}

const WRITE_FAILED = "Couldn't change notifications — check your connection and try again.";

export function NotificationLevelButton({
  target,
  store,
  api,
  targetName,
  testID = 'title-bar-notifications',
}: NotificationLevelButtonProps) {
  const view: NotificationTargetView = useStoreSelector(store, (state) =>
    resolveNotificationTarget(state.notificationPrefs, target),
  );
  // The view is rebuilt per read; `useStoreSelector`'s shallow-equal cache
  // keeps its identity while the fields are unchanged.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [status, setStatus] = useState('');

  const write = useCallback(
    async (next: NotificationLevel | 'inherit') => {
      const full = store as StateStore;
      try {
        if (next === 'inherit') {
          await clearNotificationLevel(full, api, target.scope, target.entityId);
          announce(setStatus, `Notifications: ${notificationResetLabel(target).replace(/^Use /, '')}`);
        } else {
          const pending = setNotificationLevel(full, api, target.scope, target.entityId, next);
          announce(setStatus, `Notifications: ${NOTIFICATION_LEVEL_LABEL[next]}`);
          await pending;
        }
      } catch {
        announce(setStatus, WRITE_FAILED);
      }
    },
    [api, store, target],
  );

  const label = notificationControlLabel(view, 'tap');
  const title = targetName ? `Notifications for ${targetName}` : 'Notifications';
  const current: NotificationLevel | 'inherit' = view.explicit ? view.level : 'inherit';
  const options: Array<{ value: NotificationLevel | 'inherit'; label: string }> = [
    { value: 'all', label: NOTIFICATION_LEVEL_LABEL.all },
    { value: 'mentions', label: NOTIFICATION_LEVEL_LABEL.mentions },
    { value: 'mute', label: NOTIFICATION_LEVEL_LABEL.mute },
    {
      value: 'inherit',
      label: `${notificationResetLabel(target)} (${NOTIFICATION_LEVEL_LABEL[view.inheritedLevel]})`,
    },
  ];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Long-press for all notification options"
        onPress={() => void write(nextNotificationLevel(view.level))}
        onLongPress={() => setSheetOpen(true)}
        testID={testID}
        style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
      >
        <View accessibilityElementsHidden importantForAccessibility="no" testID={`${testID}-glyph-${view.level}`}>
          <Feather
            name={levelGlyph(view.level)}
            size={18}
            color={view.explicit ? theme.colors.textPrimary : theme.colors.textMuted}
          />
        </View>
      </Pressable>

      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetOpen(false)}
        statusBarTranslucent
        testID={`${testID}-sheet-modal`}
      >
        <View style={styles.backdrop}>
          <Pressable
            style={styles.scrim}
            onPress={() => setSheetOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Dismiss notification options"
            testID={`${testID}-scrim`}
          />
          <View style={styles.sheet} accessibilityViewIsModal testID={`${testID}-sheet`}>
            <View style={styles.grabberArea}>
              <View style={styles.grabber} />
            </View>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            <View accessibilityRole="radiogroup" accessibilityLabel={title}>
              {options.map((option) => {
                const checked = current === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked }}
                    accessibilityLabel={option.label}
                    onPress={() => {
                      setSheetOpen(false);
                      void write(option.value);
                    }}
                    testID={`${testID}-option-${option.value}`}
                    style={({ pressed }) => [
                      styles.option,
                      checked ? styles.optionChecked : null,
                      pressed ? styles.buttonPressed : null,
                    ]}
                  >
                    <View style={styles.optionGlyph} accessibilityElementsHidden importantForAccessibility="no">
                      {option.value === 'inherit' ? null : (
                        <Feather name={levelGlyph(option.value)} size={20} color={theme.colors.textMuted} />
                      )}
                    </View>
                    <Text style={styles.optionText}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setSheetOpen(false)}
              testID={`${testID}-close`}
              style={styles.option}
            >
              <Text style={styles.optionText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* The confirmation, for the screen reader AND the eye: a polite live
          line (Android) beside the platform announcement (iOS). Zero-height
          when empty, so it never shifts the bar. */}
      {status ? (
        <Text style={styles.status} accessibilityLiveRegion="polite" testID={`${testID}-status`}>
          {status}
        </Text>
      ) : null}
    </>
  );
}

function announce(setStatus: (s: string) => void, text: string) {
  setStatus(text);
  try {
    AccessibilityInfo.announceForAccessibility(text);
  } catch {
    // No accessibility service (tests, some emulators): the live line stands.
  }
  setTimeout(() => setStatus(''), 2200);
}

const styles = StyleSheet.create({
  button: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radii.md,
  },
  buttonPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'transparent',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceEmphasized,
    borderTopLeftRadius: theme.radii.lg,
    borderTopRightRadius: theme.radii.lg,
    paddingBottom: theme.spacing.xl,
  },
  grabberArea: {
    minHeight: MIN_TOUCH_TARGET / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.inputBorder,
  },
  title: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
    fontWeight: '600',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  option: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    borderRadius: theme.radii.md,
  },
  optionChecked: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  optionGlyph: {
    width: 28,
    alignItems: 'center',
  },
  optionText: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.md,
  },
  status: {
    position: 'absolute',
    right: theme.spacing.sm,
    top: '100%',
    color: theme.colors.textPrimary,
    backgroundColor: theme.colors.surfaceEmphasized,
    fontSize: theme.fontSizes.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radii.sm,
  },
});
