/**
 * @cytale/mobile — reaction emoji picker (plan 004 M8, R11).
 *
 * The quick-reaction grid the action sheet hosts: the same eight-emoji
 * palette web's `ReactionPicker` starts from, one 44pt cell each, emojis the
 * message already carries dimmed and disabled (removal rides the chips, web's
 * contract). Two native differences from the web component, both deliberate:
 *
 *   * no popover/flip positioning — the sheet's react view renders the grid
 *     directly (a popover inside a modal would be a second layer to dismiss);
 *   * no favorites storage of its own. Web persists a per-browser favorites
 *     list in localStorage; native storage lands with M7's shared emoji
 *     package (`packages/emoji`), so `palette` is an injection seam — the
 *     host passes the shared catalog's favorites when it arrives, and the
 *     default stays the fixed palette until then. Nothing here imports
 *     `apps/web`'s `emojiCatalog.ts`.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MIN_TOUCH_TARGET } from '../navigation/ui';
import { theme } from '../theme';

/** The fixed reaction palette (web's `REACTION_PALETTE`, same order). */
export const REACTION_PALETTE: readonly string[] = [
  '👍',
  '👎',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🎉',
  '👀',
];

/** Spoken names for the accessibility labels (an emoji alone is not a name). */
const EMOJI_NAMES: Record<string, string> = {
  '👍': 'thumbs up',
  '👎': 'thumbs down',
  '❤️': 'heart',
  '😂': 'face with tears of joy',
  '😮': 'face with open mouth',
  '😢': 'crying face',
  '🎉': 'party popper',
  '👀': 'eyes',
};

/** Accessible name for one palette emoji (web's `reactionAriaLabel`). */
export function reactionAriaLabel(emoji: string): string {
  return `React with ${EMOJI_NAMES[emoji] ?? emoji}`;
}

/** Spoken name of an applied chip (web's `reactionChipLabel`). */
export function reactionChipLabel(emoji: string, count: number, me: boolean): string {
  const n = count === 1 ? '1 reaction' : `${count} reactions`;
  return me ? `${emoji} ${n}, including you` : `${emoji} ${n}`;
}

export interface ReactionPickerProps {
  /** Called with the picked emoji (the host owns the toggle semantics). */
  onPick: (emoji: string) => void;
  /** Emojis already applied to this message — dimmed + disabled. */
  appliedEmojis?: readonly string[];
  /** Offline gate: every cell disables (the sheet's react view). */
  disabled?: boolean;
  /** Quick palette override (shared favorites from M7's emoji package). */
  palette?: readonly string[];
  /** Renders the drill-in cell when provided (full catalog; M7 owns it). */
  onMore?: () => void;
  testID?: string;
}

export function ReactionPicker({
  onPick,
  appliedEmojis = [],
  disabled = false,
  palette = REACTION_PALETTE,
  onMore,
  testID = 'reaction-picker',
}: ReactionPickerProps) {
  return (
    <View style={styles.grid} testID={testID} role="menu" accessibilityLabel="Quick reactions">
      {palette.map((emoji) => {
        const applied = appliedEmojis.includes(emoji);
        const off = disabled || applied;
        const label = reactionAriaLabel(emoji);
        return (
          <Pressable
            key={emoji}
            role="menuitem"
            accessibilityLabel={applied ? `${label} — already applied` : label}
            accessibilityHint={applied ? 'Already applied — tap the chip to remove' : undefined}
            accessibilityState={{ disabled: off }}
            disabled={off}
            onPress={() => onPick(emoji)}
            testID={`reaction-favorite-${emoji}`}
            style={({ pressed }) => [
              styles.cell,
              applied ? styles.cellApplied : null,
              pressed && !off ? styles.cellPressed : null,
            ]}
          >
            <Text style={[styles.glyph, off ? styles.glyphOff : null]}>{emoji}</Text>
          </Pressable>
        );
      })}
      {onMore === undefined ? null : (
        <Pressable
          role="menuitem"
          accessibilityLabel="More emoji"
          disabled={disabled}
          onPress={onMore}
          testID="reaction-more"
          style={({ pressed }) => [styles.cell, pressed && !disabled ? styles.cellPressed : null]}
        >
          <Text style={styles.glyph}>＋</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
    padding: theme.spacing.sm,
  },
  cell: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surface,
  },
  cellApplied: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  cellPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  glyph: {
    fontSize: 20,
    lineHeight: 24,
  },
  glyphOff: {
    opacity: 0.4,
  },
});
