/**
 * @cytale/mobile — the navigation drawer layer (plan 004 M5, R7).
 *
 * A scrim + an edge-aligned panel that slides in from the left. The layer is
 * mounted only while open (ShellProvider owns the state) so the scrim can
 * never linger invisibly over content — the web shell's B1 defect class.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { theme } from '../theme';

/** Drawer width: never more than 85% of a phone, never more than 320pt. */
export function drawerWidth(windowWidth: number): number {
  return Math.min(320, Math.round(windowWidth * 0.85));
}

export function DrawerLayer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { width } = useWindowDimensions();
  const panelWidth = drawerWidth(width);
  const translateX = useRef(new Animated.Value(-panelWidth)).current;

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [translateX]);

  return (
    // The whole layer is the modal surface (scrim included): everything
    // behind it is hidden from assistive tech, and the scrim stays
    // reachable as the dismiss affordance.
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal testID="drawer-layer">
      <Pressable
        style={styles.scrim}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Dismiss navigation"
        testID="drawer-scrim"
      />
      <Animated.View
        style={[styles.panel, { width: panelWidth, transform: [{ translateX }] }]}
        testID="drawer-panel"
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.scrim,
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.surfaceEmphasized,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
});
