/**
 * @cytale/web — People Directory surface (U26).
 */
export { PeopleDirectory, type PeopleDirectoryProps } from './PeopleDirectory.js';
export { ProfileCard, type ProfileCardProps } from './ProfileCard.js';
export { fetchPeoplePage, type PeopleApiError, type PeopleQuery } from './api.js';
export { useDirectoryMembers, type DirectoryStore } from './useDirectoryMembers.js';
export type {
  PeopleMember,
  PeoplePage,
  PresenceByUser,
  PresenceStatus,
} from './types.js';
