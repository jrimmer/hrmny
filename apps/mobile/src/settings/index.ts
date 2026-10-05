/**
 * @cytale/mobile — settings module (plan 004 M10, R14).
 *
 * The list→section stack's pieces: the list (Log out as its final row) and
 * the three sections. Routes under `app/settings/*` are thin bindings over
 * these components.
 */
export { SettingsList, SETTINGS_SECTIONS, type SettingsListProps, type SettingsSectionKey } from './SettingsList';
export { AccountSection, type AccountSectionProps } from './AccountSection';
export { AppearanceSection } from './AppearanceSection';
export { IntegrationsSection, type IntegrationsSectionProps } from './IntegrationsSection';
export {
  createSettingsServices,
  useSettingsServices,
  type SettingsServiceOverrides,
  type SettingsServices,
  type SettingsStore,
} from './services';
