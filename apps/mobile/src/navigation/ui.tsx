/**
 * @cytale/mobile — shell UI primitives (plan 004 M5).
 *
 * The small pieces every surface repeats: the 44pt touch target, the
 * identity tile, the count badge, and section labels. Styling reads
 * `src/theme` (M3 tokens) — no Tailwind, no web class names.
 *
 * The 44pt rule is a contract, not a style choice: `MIN_TOUCH_TARGET` is the
 * floor for every interactive element (plan-003 KTD1 carried it to mobile),
 * and `IconButton` is the only way to render a bare-glyph control so the
 * floor cannot be forgotten.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../theme';

/** iOS HIG / Android minimum interactive size, in points. */
export const MIN_TOUCH_TARGET = 44;

/** Deterministic pastel-tile hue from a snowflake (ported from web's avatar.ts). */
export function avatarHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/*
 * The tile palette — a port of web's `avatarTileColor` (apps/web/src/app/ui/
 * avatar.ts), so a member's tile is the same colour on both clients: one
 * saturation, and the lightest lightness up to 42% at which WHITE initials
 * clear WCAG AA on that hue (a flat 42% measured 2.94:1 on yellow). Target
 * 4.6:1, measured on the emitted 8-bit colour.
 */
const TILE_SATURATION = 0.45;
const TILE_MAX_LIGHTNESS = 42;
const TILE_LIGHTNESS_STEP = 0.5;
const TILE_TARGET_CONTRAST = 4.6;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** WCAG contrast ratio of white text on an 8-bit sRGB colour. */
export function contrastWithWhite([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 1.05 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05);
}

const tileByHue = new Map<number, string>();

/** The tile colour for a hue (0–359), as `#rrggbb`. */
export function avatarTileColor(hue: number): string {
  const h = ((Math.round(hue) % 360) + 360) % 360;
  const cached = tileByHue.get(h);
  if (cached !== undefined) return cached;
  let rgb = hslToRgb(h, TILE_SATURATION, TILE_MAX_LIGHTNESS / 100);
  for (
    let l = TILE_MAX_LIGHTNESS;
    l > 0 && contrastWithWhite(rgb) < TILE_TARGET_CONTRAST;
    l -= TILE_LIGHTNESS_STEP
  ) {
    rgb = hslToRgb(h, TILE_SATURATION, (l - TILE_LIGHTNESS_STEP) / 100);
  }
  const hex = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  tileByHue.set(h, hex);
  return hex;
}

/** Up to two leading initials, uppercased. */
export function avatarInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export interface IconButtonProps {
  /** Required: the accessible name (icon-only controls have no text label). */
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  /** The glyph. Rendered `aria-hidden` — `label` carries the meaning. */
  children: ReactNode;
  /** Optional selected/expanded semantics for toggles. */
  selected?: boolean;
  expanded?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * A 44×44 icon control. `accessibilityRole="button"`, an explicit
 * `accessibilityLabel`, and `accessibilityState` for disabled/selected so
 * screen readers and tests meet the same contract.
 *
 * The glyph is `aria-hidden` either way — `label` carries the meaning. Bare
 * string/number glyphs ride inside one hidden `Text` (style inheritance);
 * an element face — a Feather glyph today, the workspace icon tile's View
 * tomorrow — sits in a hidden `View` instead: views inside text have layout
 * quirks on device, and the tile must stay its own renderable node.
 */
export function IconButton({
  label,
  onPress,
  disabled = false,
  children,
  selected,
  expanded,
  testID,
  style,
}: IconButtonProps) {
  const bareGlyph = typeof children === 'string' || typeof children === 'number';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected, expanded }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && !disabled ? styles.iconButtonPressed : null,
        disabled ? styles.iconButtonDisabled : null,
        style,
      ]}
    >
      {bareGlyph ? (
        <Text style={styles.iconButtonGlyph} accessibilityElementsHidden importantForAccessibility="no">
          {children}
        </Text>
      ) : (
        <View accessibilityElementsHidden importantForAccessibility="no">{children}</View>
      )}
    </Pressable>
  );
}

export interface AvatarProps {
  /** Identity source for the deterministic hue. */
  id: string;
  name: string;
  /** Presence dot color source (member rows). */
  status?: 'online' | 'idle' | 'dnd' | 'offline';
  size?: number;
  /** When false the tile is decorative (the row carries the name). */
  decorative?: boolean;
  /**
   * The server-resolved avatar/workspace image (origin-prefixed). When it
   * fails to load (or is absent) the tile falls back to the deterministic
   * initials — the hue tile is always the floor, never a wrong identity.
   */
  imageUrl?: string | null;
}

export function Avatar({ id, name, status, size = 32, decorative = true, imageUrl }: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = imageUrl !== null && imageUrl !== undefined && !imageFailed;
  return (
    <View
      style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: avatarTileColor(avatarHue(id)) }]}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no' : 'auto'}
    >
      {showImage ? (
        <Image
          source={{ uri: imageUrl }}
          style={[styles.avatarImage, { width: size, height: size, borderRadius: size / 2 }]}
          onError={() => setImageFailed(true)}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : (
        <Text style={[styles.avatarInitials, { fontSize: Math.round(size * 0.4) }]}>
          {avatarInitials(name)}
        </Text>
      )}
      {status === undefined ? null : (
        <View
          style={[styles.presenceDot, { backgroundColor: presenceColor(status) }]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      )}
    </View>
  );
}

function presenceColor(status: 'online' | 'idle' | 'dnd' | 'offline'): string {
  switch (status) {
    case 'online':
      return theme.colors.presenceOnline;
    case 'idle':
      return theme.colors.presenceIdle;
    case 'dnd':
      return theme.colors.presenceDnd;
    default:
      return theme.colors.presenceOffline;
  }
}

/** A count pill (unread / mentions). Renders nothing for 0. */
export function Badge({ count, tone = 'neutral', testID }: { count: number; tone?: 'neutral' | 'mention'; testID?: string }) {
  if (count <= 0) return null;
  return (
    <View style={[styles.badge, tone === 'mention' ? styles.badgeMention : styles.badgeNeutral]} testID={testID}>
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

/** A muted uppercase section label inside the drawer. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.sectionLabel} accessibilityRole="header">
      {children}
    </Text>
  );
}

/** A hairline divider. */
export function Divider() {
  return <View style={styles.divider} accessibilityElementsHidden importantForAccessibility="no" />;
}

const styles = StyleSheet.create({
  iconButton: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radii.md,
  },
  iconButtonPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  iconButtonDisabled: {
    opacity: 0.4,
  },
  iconButtonGlyph: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.xl,
    lineHeight: theme.fontSizes.xl + 4,
  },
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    resizeMode: 'cover',
  },
  avatarInitials: {
    color: theme.colors.onAccent,
    fontWeight: '700',
  },
  presenceDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme.colors.surfaceEmphasized,
  },
  badge: {
    minWidth: 20,
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: 1,
    borderRadius: theme.radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeNeutral: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  badgeMention: {
    backgroundColor: theme.colors.danger,
  },
  badgeText: {
    color: theme.colors.onAccent,
    fontSize: theme.fontSizes.xs,
    fontWeight: '700',
  },
  sectionLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
  },
});
