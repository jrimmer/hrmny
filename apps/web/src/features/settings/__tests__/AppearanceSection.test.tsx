/**
 * AppearanceSection — the #151 two-axis selector (Mode Dark|Light × Style
 * Harmony|Pixel): live document-attribute application, per-axis
 * persistence, and the real reduce-motion toggle.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { AppearanceSection, REDUCE_MOTION_KEY } from '../AppearanceSection.js';
import { STYLE_KEY, THEME_KEY } from '../../../app/theme/prefs.js';
import {
  DEVICE_CACHE_SETTING_KEY,
  setSnapshotStorageForTests,
  snapshotKey,
  type SnapshotStorage,
} from '../../../app/persist/deviceCache.js';

afterEach(() => cleanup());

describe('AppearanceSection — mode axis (#151)', () => {
  it('defaults to dark + harmony when nothing is stored', () => {
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(STYLE_KEY);
    render(<AppearanceSection />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-style')).toBe('harmony');
  });

  it('selecting light applies the attribute live and persists it', async () => {
    localStorage.removeItem(THEME_KEY);
    render(<AppearanceSection />);
    await userEvent.setup().click(screen.getByTestId('appearance-mode-light'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    // The style axis is untouched — the axes are independent.
    expect(document.documentElement.getAttribute('data-style')).toBe('harmony');
  });

  it('restores a stored mode at mount', () => {
    localStorage.setItem(THEME_KEY, 'light');
    render(<AppearanceSection />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('AppearanceSection — style axis (#151)', () => {
  it('selecting pixel applies the attribute live and persists it', async () => {
    localStorage.removeItem(STYLE_KEY);
    localStorage.removeItem(THEME_KEY);
    render(<AppearanceSection />);
    await userEvent.setup().click(screen.getByTestId('appearance-style-pixel'));
    expect(document.documentElement.getAttribute('data-style')).toBe('pixel');
    expect(localStorage.getItem(STYLE_KEY)).toBe('pixel');
    // The mode axis is untouched.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('harmony remains selectable after pixel', async () => {
    localStorage.setItem(STYLE_KEY, 'pixel');
    render(<AppearanceSection />);
    expect(document.documentElement.getAttribute('data-style')).toBe('pixel');
    await userEvent.setup().click(screen.getByTestId('appearance-style-harmony'));
    expect(document.documentElement.getAttribute('data-style')).toBe('harmony');
    expect(localStorage.getItem(STYLE_KEY)).toBe('harmony');
  });
});

describe('AppearanceSection — reduce motion', () => {
  it('toggle flips the document attribute and persists', async () => {
    localStorage.removeItem(REDUCE_MOTION_KEY);
    render(<AppearanceSection />);
    const toggle = screen.getByTestId('appearance-reduce-motion');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false);

    await userEvent.setup().click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(true);
    expect(localStorage.getItem(REDUCE_MOTION_KEY)).toBe('1');

    await userEvent.setup().click(toggle);
    expect(document.documentElement.hasAttribute('data-reduce-motion')).toBe(false);
    expect(localStorage.getItem(REDUCE_MOTION_KEY)).toBe('0');
  });
});

describe('AppearanceSection — device cache opt-out (lane D #8)', () => {
  it('the switch persists the opt-out and clears what the device kept', async () => {
    localStorage.removeItem(DEVICE_CACHE_SETTING_KEY);
    const data = new Map<string, unknown>([[snapshotKey('o', 'u'), { version: 1 }]]);
    const mem: SnapshotStorage = {
      get: async (k) => data.get(k),
      put: async (k, v) => {
        data.set(k, v);
      },
      delete: async (k) => {
        data.delete(k);
      },
      clear: async () => {
        data.clear();
      },
    };
    const prev = setSnapshotStorageForTests(mem);
    try {
      render(<AppearanceSection />);
      const toggle = screen.getByRole('switch', { name: "Don't keep messages on this device" });
      expect(toggle.getAttribute('aria-checked')).toBe('false');

      await userEvent.setup().click(toggle);
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(localStorage.getItem(DEVICE_CACHE_SETTING_KEY)).toBe('off');
      expect(data.size).toBe(0);

      await userEvent.setup().click(toggle);
      expect(localStorage.getItem(DEVICE_CACHE_SETTING_KEY)).toBeNull();
    } finally {
      setSnapshotStorageForTests(prev);
    }
  });
});
