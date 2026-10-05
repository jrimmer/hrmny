/**
 * @cytale/web — message surface (U21 + reactions).
 */
export { MessageCompose, type MessageComposeProps } from './MessageCompose.js';
export { useMessages, type ReactionError, type UseMessages } from './useMessages.js';
export { MessageList, type MessageListProps, type MessageListLoadState } from './MessageList.js';
export { MessageItem, type MessageItemProps } from './MessageItem.js';
export {
  MessageActionsSheet,
  type MessageActionsSheetProps,
} from './MessageActionsSheet.js';
export {
  MessageComponents,
  parseActionRows,
  safeLinkHref,
  type MessageComponentsProps,
} from './MessageComponents.js';
export { MessagePane, type MessagePaneProps } from './MessagePane.js';
export {
  REACTION_PALETTE,
  ReactionPicker,
  reactionAriaLabel,
  type ReactionPickerProps,
} from './ReactionPicker.js';
export {
  applyReactionAdd,
  applyReactionEvent,
  applyReactionRemove,
  applyReactionRemoveAll,
  type DispatchFrame,
  type ReactionRemoveAllPayload,
  type ReactionTogglePayload,
} from './reactions.js';
export {
  linkAnchorProps,
  renderInlineMarkdown,
  renderMarkdown,
  renderMarkdownBlocks,
  type PermalinkChipRenderer,
} from './markdown.js';
export { PermalinkChip, type PermalinkChipProps } from './permalinkChip.js';
export {
  PathPermalinkNotice,
  usePathPermalink,
  PERMALINK_LANDING_FAILED,
  type PathPermalinkState,
  type PermalinkResolver,
  type ResolvedPermalinkTarget,
} from './usePathPermalink.js';
export {
  mintPermalinkUrl,
  permalinkTokenFromPath,
  permalinkUrlForToken,
  PERMALINK_PATH_PREFIX,
  type InstancePermalinkTarget,
  type PermalinkMinter,
  type TokenPermalinkTarget,
} from './messagePermalink.js';
export type {
  AuthorOverride,
  EmbedField,
  MessageEmbed,
  MessageWithBots,
  ParsedButtonControl,
  ParsedControl,
  ParsedSelectControl,
  ParsedSelectOption,
} from './types.js';
