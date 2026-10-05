/**
 * @cytale/web — presence, typing, and unread (U23) barrel.
 */

export { usePresence, presenceOf, type PresenceByUser } from './usePresence.js';
export { useTyping, TYPING_TIMEOUT_MS, type Typist, type TypingByChannel, type UseTyping } from './useTyping.js';
export { useUnread, type UnreadBadge, type UseUnread } from './useUnread.js';
export { TypingIndicator, typingLabel, type TypingIndicatorProps } from './TypingIndicator.js';
export { PresenceIndicator, type PresenceIndicatorProps } from './PresenceIndicator.js';
