/**
 * @cytale/mobile — one message row (plan 004 M6, R8; M8 long-press + chips).
 *
 * Avatar + author + timestamp on the first line of a group, continuation
 * lines compact (no avatar/author — the Discord cadence the web list uses),
 * the body rendered through the shared markdown parse tree as nested
 * `<Text>` runs, plus the two list decorations the row hosts: the date rule
 * and the unread "NEW" divider. M8 adds the touch half: the row reports a
 * long-press (the LIST owns the sheet, so a recycled row can never close an
 * open one) and renders the reaction chip row with the same toggle seam the
 * web row's chips use.
 *
 * Link runs are pressable (44pt is not the constraint here — the run is
 * inline text — but the label is the link text, so the control has a name);
 * mentions are styled, not pressable (member-profile push is M9+).
 *
 * Reaction chips only render on CONFIRMED rows (`pending_…` optimistic sends
 * never carry them) and only when the wire key is present, mirroring the web
 * row's `showReactionRow` guard. The chip's pressable box is 44pt tall (R18)
 * with the 32pt pill centered inside: `hitSlop` cannot grow a target past its
 * parent's bounds, and the chip row is only as tall as the box.
 *
 * Render cost (performance pass, P1): the row is wrapped in `React.memo` and
 * every prop is either a primitive or a stable callback, so a list re-render
 * that does not change THIS row's inputs bails out before the render body —
 * which is what keeps a recycled FlashList cell from re-parsing its markdown
 * on every inbound message. Two consequences the list honours:
 *
 *   * the action seams take the message id (`onLongPress(id)`,
 *     `onToggleReaction(id, emoji)`) so the list can pass ONE stable callback
 *     instead of a fresh per-row closure — a closure prop would defeat the
 *     memo for every row, on every render;
 *   * the markdown parse is memoized on `[content, resolveMention]`, so even a
 *     legitimate re-render (a reaction landing on this row) re-uses the runs.
 *
 * Link safety: a message body is peer-authored, and the OS opener would
 * happily take `intent://`, `tel:` or `sms:` — so a link run is only pressable
 * when its scheme is allowlisted (`isOpenableLinkHref`), and the opener call
 * itself is gated again as a last resort. A rejected target renders as plain
 * text: an inert underline would advertise a control that cannot act.
 */
import { memo, useCallback, useMemo } from 'react';
import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import type { MessageWithReactions, ReactionSummary } from '@cytale/api-client';
import type { Message } from '@cytale/domain';

import { theme } from '../theme';
import { Avatar } from '../navigation/ui';
import { inlineRuns, isOpenableLinkHref, type InlineRun, type MentionResolver } from './markdown';
import { reactionAriaLabel, reactionChipLabel } from './ReactionPicker';
import { useLongPress } from './useLongPress';

export interface MessageRowProps {
  message: Message;
  /** Resolved author display name (nickname/username); id is the fallback. */
  authorName?: string;
  /** Continuation line: hide avatar + author, indent under the avatar column. */
  grouped?: boolean;
  /** Date label above this row (the calendar day changed); null = none. */
  dateLabel?: string | null;
  /** Render the unread divider above this row (the watermark's first row). */
  unreadDivider?: boolean;
  /** Resolves `<@snowflake>` to a display name (roster + self). */
  resolveMention?: MentionResolver;
  /** Opens a link run; defaults to the platform browser. */
  onOpenLink?: (href: string) => void;
  /**
   * Long-press report — the list opens the action sheet for this row. Takes
   * the id so the list can pass one stable callback for every row (a per-row
   * closure would defeat `React.memo`).
   */
  onLongPress?: (messageId: string) => void;
  /** Toggles one emoji on THIS message (the chips' seam, M8). Id first, the
   *  same shape as the list's own seam, for the same memo reason. */
  onToggleReaction?: (messageId: string, emoji: string) => void;
}

function MessageRowView({
  message,
  authorName,
  grouped = false,
  dateLabel = null,
  unreadDivider = false,
  resolveMention,
  onOpenLink,
  onLongPress,
  onToggleReaction,
}: MessageRowProps) {
  const messageId = message.id;

  // Parse once per (content, resolver): a re-render for an unrelated reason
  // (a reaction landing, a divider moving) must not re-tokenize the body.
  const runs = useMemo(
    () => inlineRuns(message.content, resolveMention),
    [message.content, resolveMention],
  );

  const handleLongPress = useCallback(
    () => onLongPress?.(messageId),
    [messageId, onLongPress],
  );

  const longPress = useLongPress({
    onLongPress: handleLongPress,
    enabled: onLongPress !== undefined,
  });

  const openLink = useCallback(
    (href: string) => {
      // Scheme allowlist before anything can hand the target to another app:
      // a channel peer authors this string (see the module docs + SECURITY).
      if (!isOpenableLinkHref(href)) return;
      if (onOpenLink) {
        onOpenLink(href);
        return;
      }
      // Best-effort: a bad href must not take the screen down.
      void Linking.openURL(href).catch(() => undefined);
    },
    [onOpenLink],
  );

  const toggleReaction = useCallback(
    (emoji: string) => onToggleReaction?.(messageId, emoji),
    [messageId, onToggleReaction],
  );

  // Confirmed rows only, and only when the wire key is present.
  const reactions: ReactionSummary[] = message.id.startsWith('pending_')
    ? []
    : ((message as MessageWithReactions).reactions ?? []).filter(
        (r) => r && typeof r.emoji === 'string' && typeof r.count === 'number',
      );

  return (
    <View testID={`message-row-${message.id}`} {...longPress}>
      {dateLabel === null ? null : <DateDivider label={dateLabel} />}
      {unreadDivider ? <UnreadDivider /> : null}
      <View style={[styles.row, grouped ? styles.rowGrouped : null]}>
        {grouped ? (
          <View style={styles.avatarGutter} />
        ) : (
          <Avatar id={message.author_id} name={authorName ?? message.author_id} size={36} />
        )}
        <View style={styles.body}>
          {grouped ? null : (
            <View style={styles.authorLine}>
              <Text style={styles.author} testID="message-author" numberOfLines={1}>
                {authorName ?? message.author_id}
              </Text>
              <Text style={styles.timestamp} testID="message-time">
                {formatMessageTime(message.created_at)}
              </Text>
            </View>
          )}
          <Text style={styles.content} testID="message-content">
            {runs.map((run, index) => (
              <Run key={`${message.id}-${index}`} run={run} onOpenLink={openLink} />
            ))}
          </Text>
          {reactions.length === 0 ? null : (
            <View style={styles.reactionRow} testID="reaction-row">
              {reactions.map((reaction) => (
                <Pressable
                  key={reaction.emoji}
                  accessibilityRole="button"
                  accessibilityLabel={reactionChipLabel(reaction.emoji, reaction.count, reaction.me)}
                  accessibilityState={{
                    selected: reaction.me,
                    disabled: onToggleReaction === undefined,
                  }}
                  accessibilityHint={reaction.me ? 'Removes your reaction' : reactionAriaLabel(reaction.emoji)}
                  disabled={onToggleReaction === undefined}
                  onPress={() => toggleReaction(reaction.emoji)}
                  // The target is this box (44pt, R18); the pill inside stays
                  // 32pt so the row's density does not change.
                  testID={`reaction-chip-${reaction.emoji}`}
                  style={styles.chipTarget}
                >
                  {({ pressed }) => (
                    <View
                      style={[
                        styles.chip,
                        reaction.me ? styles.chipMine : null,
                        pressed && onToggleReaction !== undefined ? styles.chipPressed : null,
                      ]}
                      testID={`reaction-pill-${reaction.emoji}`}
                    >
                      <Text style={styles.chipGlyph}>{reaction.emoji}</Text>
                      <Text style={[styles.chipCount, reaction.me ? styles.chipCountMine : null]}>
                        {reaction.count}
                      </Text>
                    </View>
                  )}
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * Shallow-comparing memo wrapper. Every prop is a primitive or a stable
 * callback by contract (see the module docs); the list supplies the derived
 * values and one shared action callback per action, so a row whose inputs did
 * not change never enters its render body.
 */
export const MessageRow = memo(MessageRowView);
MessageRow.displayName = 'MessageRow';
/** The emphasis styles a run's marks add, in one style array. */
function markStyles(run: InlineRun): StyleProp<TextStyle>[] {
  const marks = run.marks ?? [];
  const out: StyleProp<TextStyle>[] = [];
  if (marks.includes('bold')) out.push(styles.bold);
  if (marks.includes('italic')) out.push(styles.italic);
  const underline = marks.includes('underline');
  const strike = marks.includes('strike');
  if (underline && strike) out.push(styles.underlineStrike);
  else if (underline) out.push(styles.underline);
  else if (strike) out.push(styles.strike);
  return out;
}

function Run({ run, onOpenLink }: { run: InlineRun; onOpenLink: (href: string) => void }) {
  const marks = markStyles(run);
  switch (run.kind) {
    case 'mention':
      return (
        <Text
          style={[...marks, styles.mention]}
          testID={`mention-${run.userId ?? ''}`}
          accessibilityLabel={run.text}
        >
          {run.text}
        </Text>
      );
    case 'channel':
      return <Text style={[...marks, styles.mention]}>{run.text}</Text>;
    case 'code':
      return <Text style={[...marks, styles.code]}>{run.text}</Text>;
    case 'link': {
      const href = run.href ?? '';
      // A link the row would refuse to open is not a control: render its
      // label as plain text rather than advertising an inert underline.
      if (!isOpenableLinkHref(href)) return <Text style={marks}>{run.text}</Text>;
      return (
        <Text
          style={[...marks, styles.link]}
          accessibilityRole="link"
          onPress={() => onOpenLink(href)}
        >
          {run.text}
        </Text>
      );
    }
    case 'text':
    default:
      return marks.length > 0 ? <Text style={marks}>{run.text}</Text> : <Text>{run.text}</Text>;
  }
}

/**
 * Thin centered date rule (web parity: `date-divider`).
 *
 * `role="separator"` (the ARIA role prop), not `accessibilityRole`: RN's
 * legacy `AccessibilityRole` union has no separator member, while the modern
 * `role` prop does — same announced semantics, type-correct. Screen readers
 * read the label ("September 8, 2026") as the separator's name.
 */
export function DateDivider({ label }: { label: string }) {
  return (
    <View style={styles.dividerRow} role="separator" accessibilityLabel={label} testID="date-divider">
      <View style={styles.dividerLine} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

/** Discord-style unread rule: danger hairline with a "NEW" pill. */
export function UnreadDivider() {
  return (
    <View
      style={styles.unreadRow}
      role="separator"
      accessibilityLabel="New messages"
      testID="unread-divider"
    >
      <Text style={styles.unreadPill}>NEW</Text>
      <View style={styles.unreadLine} />
    </View>
  );
}

/**
 * Local time, hour:minute. `toLocaleTimeString` is locale/TZ dependent —
 * tests assert shape, not an exact string (a device in another zone is not
 * a regression).
 */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Calendar-day label for the date divider. */
export function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xs,
    gap: theme.spacing.md,
  },
  rowGrouped: {
    paddingTop: 0,
  },
  avatarGutter: {
    width: 36,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  authorLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.spacing.sm,
  },
  author: {
    color: theme.colors.textPrimary,
    fontSize: theme.fontSizes.lg,
    fontWeight: '600',
    flexShrink: 1,
  },
  timestamp: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
  },
  content: {
    color: theme.colors.text,
    fontSize: theme.fontSizes.lg,
    lineHeight: 21,
  },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing.xs,
    marginTop: theme.spacing.xs,
  },
  chipTarget: {
    // The touch target (R18): the pill is centered inside, visually 32pt.
    minHeight: 44,
    justifyContent: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    minHeight: 32,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  chipMine: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surfaceSelected,
  },
  chipPressed: {
    backgroundColor: theme.colors.surfaceHover,
  },
  chipGlyph: {
    fontSize: theme.fontSizes.md,
    lineHeight: 18,
  },
  chipCount: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    fontWeight: '600',
  },
  chipCountMine: {
    color: theme.colors.textPrimary,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  underline: {
    textDecorationLine: 'underline',
  },
  strike: {
    textDecorationLine: 'line-through',
  },
  underlineStrike: {
    textDecorationLine: 'underline line-through',
  },
  code: {
    fontFamily: 'Courier',
    backgroundColor: theme.colors.surfaceEmphasized,
    color: theme.colors.textPrimary,
  },
  mention: {
    color: theme.colors.focusRing,
    backgroundColor: theme.colors.surfaceSelected,
    fontWeight: '600',
  },
  link: {
    color: theme.colors.focusRing,
    textDecorationLine: 'underline',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
  },
  dividerLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.fontSizes.xs,
    fontWeight: '500',
  },
  unreadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  unreadPill: {
    backgroundColor: theme.colors.danger,
    color: theme.colors.onAccent,
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: 1,
    borderRadius: theme.radii.sm,
    overflow: 'hidden',
  },
  unreadLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.danger,
  },
});
