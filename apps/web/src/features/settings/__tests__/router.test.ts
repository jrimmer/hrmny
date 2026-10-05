/**
 * Settings route grammar: open/normalize `#/settings/:section`, plus the alias
 * that keeps the removed integrations surface's addresses landing somewhere.
 */
import { describe, expect, it } from 'vitest';

import {
  SETTINGS_SECTIONS,
  aliasLegacyIntegrationsPath,
  parseSettingsPath,
} from '../router.js';

describe('aliasLegacyIntegrationsPath', () => {
  // The rail surface is GONE, so a bookmark, a pasted link, or a client that
  // cached the old route must still arrive at the thing it named. A dead route
  // would be an incomplete relocation, not a tidy one (KD7).
  it('maps each old pane to the settings section that replaced it', () => {
    expect(aliasLegacyIntegrationsPath('/integrations/agents')).toBe('/settings/integrations');
    expect(aliasLegacyIntegrationsPath('/integrations/webhooks')).toBe('/settings/webhooks');
  });

  it('the bare prefix lands where it used to OPEN — agents', () => {
    expect(aliasLegacyIntegrationsPath('/integrations')).toBe('/settings/integrations');
    expect(aliasLegacyIntegrationsPath('/integrations/')).toBe('/settings/integrations');
  });

  // Anything unrecognized takes the same route as the bare prefix rather than
  // 404ing: the old surface normalized its own unknown panes the same way.
  it('an unknown pane falls back to agents', () => {
    expect(aliasLegacyIntegrationsPath('/integrations/bots')).toBe('/settings/integrations');
    expect(aliasLegacyIntegrationsPath('/integrations/agents/extra')).toBe(
      '/settings/integrations',
    );
  });

  // Null is the contract that lets the caller fall through to normal parsing —
  // and, importantly, that keeps a SETTINGS path from being rewritten by it.
  it('is null for anything that is not the legacy prefix', () => {
    expect(aliasLegacyIntegrationsPath('/')).toBeNull();
    expect(aliasLegacyIntegrationsPath('/settings/webhooks')).toBeNull();
    expect(aliasLegacyIntegrationsPath('/integrations-extra')).toBeNull();
    expect(aliasLegacyIntegrationsPath('/settings')).toBeNull();
  });

  it('always lands on a real section — the alias can never strand', () => {
    for (const p of [
      '/integrations',
      '/integrations/agents',
      '/integrations/webhooks',
      '/integrations/x',
    ]) {
      const target = aliasLegacyIntegrationsPath(p);
      expect(target).not.toBeNull();
      expect(parseSettingsPath(target!).open).toBe(true);
    }
  });
});

describe('parseSettingsPath', () => {
  it('closed for unrelated paths', () => {
    expect(parseSettingsPath('/')).toEqual({ open: false, section: 'account' });
    expect(parseSettingsPath('/integrations/bots')).toEqual({ open: false, section: 'account' });
    expect(parseSettingsPath('/settings-extra/x')).toEqual({ open: false, section: 'account' });
  });

  it('opens each known section', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseSettingsPath(`/settings/${section}`)).toEqual({ open: true, section });
    }
  });

  it('bare prefix and unknown segments normalize to account', () => {
    expect(parseSettingsPath('/settings')).toEqual({ open: true, section: 'account' });
    expect(parseSettingsPath('/settings/')).toEqual({ open: true, section: 'account' });
    expect(parseSettingsPath('/settings/nonsense')).toEqual({ open: true, section: 'account' });
  });

  it('ignores deeper segments (one-segment grammar)', () => {
    expect(parseSettingsPath('/settings/integrations/extra')).toEqual({
      open: true,
      section: 'integrations',
    });
  });
});
