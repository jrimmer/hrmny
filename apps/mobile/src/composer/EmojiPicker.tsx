/**
 * @cytale/mobile — composer emoji picker (plan 004 M7, KTD6).
 *
 * The web panel's native twin: a search field over the SHARED catalog, the
 * user's Favorites row (settings-curated on web; per-account on native),
 * Frequently Used (frecents), then the full grid. Picks go back to the
 * composer's caret; the panel owns no insertion logic.
 *
 * Favorites/frecents are filtered to catalog membership before rendering —
 * storage may hold emoji a catalog update dropped, and rendering an unknown
 * glyph would insert something the wire has no shortcode for.
 *
 * Render cost (performance pass, P2): every cell's hint resolves through
 * `canonicalShortcode`, an O(1) index built once in `@cytale/emoji`. The
 * previous `shortcodesFor(emoji)[0]` was a linear `find` over the catalog per
 * cell — ~17.7k string comparisons to render the grid, repeated on every
 * keystroke in the panel's own search field. The grid stays a plain
 * `ScrollView`: see the note above the panel for why virtualization was not
 * taken here.
 *
 * Memoized (P3): the composer re-renders on every keystroke, but the panel's
 * props (`onPick`, `onClose`, `preferences`) are all stable — the panel's own
 * search state is what re-renders it. A memo boundary therefore keeps the
 * whole catalog grid out of the composer's keystroke path.
 */
import { memo, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { canonicalShortcode, searchEmojiCatalog, type EmojiPreferences } from '@cytale/emoji';

import { MIN_TOUCH_TARGET } from '../navigation/ui';
import { theme } from '../theme';

export interface EmojiPickerProps {
  /** Insert the emoji at the composer's caret. */
  onPick: (emoji: string) => void;
  /** Close request (the composer toggles the panel). */
  onClose: () => void;
  preferences: EmojiPreferences;
  testID?: string;
}

const FRECENTS_SHOWN = 8;

function EmojiPickerView({
  onPick,
  onClose,
  preferences,
  testID = 'emoji-picker-panel',
}: EmojiPickerProps) {
  const [query, setQuery] = useState('');

  const rows = useMemo(() => searchEmojiCatalog(query), [query]);
  const known = useMemo(() => new Set(searchEmojiCatalog('').map((row) => row.e)), []);
  const searching = query.trim().length > 0;
  const favorites = useMemo(
    () => (searching ? [] : preferences.readFavorites().filter((e) => known.has(e))),
    [searching, preferences, known],
  );
  const frecents = useMemo(() => {
    if (searching) return [];
    const out: string[] = [];
    for (const emoji of preferences.readFrecents()) {
      if (out.length >= FRECENTS_SHOWN) break;
      if (known.has(emoji) && !out.includes(emoji)) out.push(emoji);
    }
    return out;
  }, [searching, preferences, known]);

  const cell = (emoji: string, key: string, favorite = false) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityLabel={`Insert ${emoji}`}
      accessibilityHint={canonicalShortcode(emoji)}
      onPress={() => onPick(emoji)}
      testID="emoji-cell"
      {...(favorite ? { accessibilityState: { selected: false } } : {})}
      style={({ pressed }) => [styles.cell, pressed ? styles.cellPressed : null]}
    >
      <Text style={styles.cellGlyph}>{emoji}</Text>
    </Pressable>
  );

  return (
    <View style={styles.panel} accessibilityLabel="Emoji picker" testID={testID}>
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Find the perfect emoji"
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel="Search emoji"
          testID="emoji-search"
          autoFocus
          style={styles.search}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close emoji picker"
          onPress={onClose}
          testID="emoji-picker-close"
          style={({ pressed }) => [styles.close, pressed ? styles.cellPressed : null]}
        >
          <Text style={styles.closeGlyph}>✕</Text>
        </Pressable>
      </View>

      {/*
        Deliberately NOT virtualized (P2 decision): the panel is a
        content-sized box capped by `maxHeight` (320) inside the composer, and
        that cap — not a measured, bounded height — is what limits the grid
        today. A `FlatList`/`numColumns` grid needs a real height to window
        against and a computed column count for its fixed item width; giving
        it one means either a hard-coded height (the panel would no longer
        shrink for a three-match search — a visible behaviour change) or an
        `onLayout`-measured one (a frame of unlaid-out cells, re-measured
        whenever favorites/frecents appear). With the O(1) shortcode index the
        grid's render is linear in the catalog, so the measured win does not
        justify that regression in the sheet's own measurement — the panel
        keeps the wrapping ScrollView it was designed around.
      */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.grid}
        keyboardShouldPersistTaps="handled"
        testID="emoji-grid"
      >
        {favorites.length > 0 ? (
          <>
            <Text style={styles.section} accessibilityRole="header">
              Favorites
            </Text>
            {favorites.map((emoji) => cell(emoji, `fav-${emoji}`, true))}
          </>
        ) : null}
        {frecents.length > 0 ? (
          <>
            <Text style={styles.section} accessibilityRole="header">
              Frequently Used
            </Text>
            {frecents.map((emoji) => cell(emoji, `freq-${emoji}`))}
          </>
        ) : null}
        {favorites.length > 0 || frecents.length > 0 ? (
          <Text style={styles.section} accessibilityRole="header">
            All
          </Text>
        ) : null}
        {rows.map((row) => cell(row.e, `${row.n}-${row.e}`))}
        {rows.length === 0 ? (
          <Text style={styles.empty} testID="emoji-empty">
            No emoji match “{query.trim()}”.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * Shallow-comparing memo wrapper. The panel owns its search state, so it keeps
 * re-rendering itself as the user types; the boundary only stops the COMPOSER's
 * keystrokes from re-rendering the grid.
 */
export const EmojiPicker = memo(EmojiPickerView);
EmojiPicker.displayName = 'EmojiPicker';

const styles = StyleSheet.create({
  panel: {
    maxHeight: 320,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceEmphasized,
    paddingBottom: theme.spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  search: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.inputBorder,
    backgroundColor: theme.colors.input,
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.md,
  },
  close: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radii.md,
  },
  closeGlyph: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.lg,
  },
  scroll: {
    marginTop: theme.spacing.sm,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: theme.spacing.sm,
  },
  section: {
    width: '100%',
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.xs,
  },
  cell: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radii.md,
  },
  cellPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  cellGlyph: {
    fontSize: 22,
  },
  empty: {
    width: '100%',
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.sm,
    textAlign: 'center',
    paddingVertical: theme.spacing.lg,
  },
});
