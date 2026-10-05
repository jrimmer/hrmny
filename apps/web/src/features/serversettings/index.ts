/**
 * @cytale/web — the server settings surface (the Home gear's operator entry, #121).
 */
export {
  parseServerSettingsPath,
  useServerSettingsRoute,
  SERVER_SETTINGS_ROUTE_PREFIX,
} from './router.js';
export type { ServerSettingsRoute, ServerSettingsRouteMatch } from './router.js';
export { ServerSettingsPage } from './ServerSettingsPage.js';
export type { ServerSettingsPageProps } from './ServerSettingsPage.js';
