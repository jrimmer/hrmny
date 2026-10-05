/**
 * @cytale/web — Channel Sidebar surface (U20).
 */
export { ChannelSidebar, type ChannelSidebarProps, type ChannelCategorySpec } from './ChannelSidebar.js';
export { ChannelListItem, type ChannelListItemProps } from './ChannelListItem.js';
export { CategoryGroup, type CategoryGroupProps } from './CategoryGroup.js';
export { WorkspaceSwitcher, type WorkspaceSwitcherProps } from './WorkspaceSwitcher.js';
export { InviteLandingPage, type InviteLandingPageProps } from './InviteLandingPage.js';
export {
  CreateChannelDialog,
  channelSlug,
  type CreateChannelDialogProps,
} from './CreateChannelDialog.js';
export { CreateWorkspaceDialog, type CreateWorkspaceDialogProps } from './CreateWorkspaceDialog.js';
export {
  InvitePeopleDialog,
  inviteUrl,
  type InvitePeopleDialogProps,
  type CreateInviteInput,
} from './InvitePeopleDialog.js';
export { WorkspaceMenu, type WorkspaceMenuProps } from './WorkspaceMenu.js';
export {
  ChannelContextMenu,
  useChannelLongPress,
  LONG_PRESS_MS,
  type ChannelContextMenuProps,
} from './ChannelContextMenu.js';
export { resolveInvite, acceptInvite, type ResolvedInvite, type InviteApiError } from './api.js';
export { useSidebarProjection, type SidebarStore, type SidebarProjection, type SidebarLiveCall } from './useSidebarProjection.js';
