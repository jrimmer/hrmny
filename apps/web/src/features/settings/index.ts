/**
 * @cytale/web — user settings surface (the bottom-left gear): menu in the
 * sidebar column, section content in the pane column, fourth column hidden.
 */
export {
  SETTINGS_ROUTE_PREFIX,
  SETTINGS_SECTIONS,
  aliasLegacyIntegrationsPath,
  LEGACY_INTEGRATIONS_PREFIX,
  parseSettingsPath,
  useSettingsRoute,
  type SettingsRoute,
  type SettingsRouteMatch,
  type SettingsSection,
} from './router.js';
export { SettingsNav, sectionTitle } from './SettingsNav.js';
export { SettingsPane } from './SettingsPane.js';
export type { ChannelOption, TreeWorkspace } from './types.js';
export { AccountSection } from './AccountSection.js';
export { PasskeysSection, type PasskeysSectionProps } from './PasskeysSection.js';
export { AppearanceSection, applyReduceMotion, readReduceMotion } from './AppearanceSection.js';
export { AgentsSection, type AgentsSectionProps } from './AgentsSection.js';
export { WebhooksSection, describeDestination, type WebhooksSectionProps } from './WebhooksSection.js';
export { SshSection } from './SshSection.js';
export { ReactionEmojiSection } from './ReactionEmojiSection.js';
export {
  NotificationsSection,
  resolveFromOverrides,
  overrideKey,
  describeRow,
  describeDelivery,
  computeDeliveryState,
  canDeliverNotifications,
  readNotificationPermission,
  DEFAULT_LEVEL,
  type NotificationRow,
  type NotificationLevel,
} from './NotificationsSection.js';
