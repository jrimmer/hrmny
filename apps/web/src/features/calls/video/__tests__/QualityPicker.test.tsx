/**
 * @cytale/web — QualityPicker tests (calls V2 plan U5a, R2/R9, VM20).
 *
 * Sender presets per source (camera low/medium/high; screen + Source), the
 * receiver max-quality trio (high/medium/low — the VideoQualityPreference
 * vocabulary), the house keyboard menu contract, and the ratified VM20
 * pre-disabled state: native disabled WITH an explanatory title, menu
 * unreachable, nothing disappearing.
 */
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import { QualityPicker } from '../QualityPicker.js';

afterEach(() => {
  cleanup();
});

// -- sender presets (R2) -----------------------------------------------------------

describe('QualityPicker — sender presets', () => {
  it('camera: low/medium/high with resolution · fps labels', async () => {
    render(<QualityPicker kind="sender" source="camera" value="high" onPick={() => {}} context="panel" />);
    await userEvent.click(screen.getByTestId('quality-trigger-panel'));
    const options = screen.getAllByTestId('quality-option-panel');
    expect(options.map((o) => o.getAttribute('data-quality'))).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(options[0]!.textContent).toContain('240p · 15 fps');
    expect(options[1]!.textContent).toContain('360p · 30 fps');
    expect(options[2]!.textContent).toContain('720p · 30 fps');
  });

  it('screen: adds the uncapped Source tier', async () => {
    render(<QualityPicker kind="sender" source="screen" value="medium" onPick={() => {}} context="panel" />);
    await userEvent.click(screen.getByTestId('quality-trigger-panel'));
    const options = screen.getAllByTestId('quality-option-panel');
    expect(options.map((o) => o.getAttribute('data-quality'))).toEqual([
      'low',
      'medium',
      'high',
      'source',
    ]);
    expect(options[3]!.textContent).toContain('Source (uncapped)');
  });

  it('trigger carries the current tier in its accessible name and title', () => {
    render(<QualityPicker kind="sender" source="camera" value="medium" onPick={() => {}} context="panel" />);
    const trigger = screen.getByTestId('quality-trigger-panel');
    expect(trigger.getAttribute('aria-label')).toBe('Camera quality: 360p · 30 fps');
    expect(trigger.getAttribute('title')).toBe('Camera quality: 360p · 30 fps');
    expect(trigger.textContent).toContain('360p · 30 fps');
  });
});

// -- receiver max-quality (R9) -----------------------------------------------------

describe('QualityPicker — receiver max-quality', () => {
  it('offers high/medium/low (VideoQualityPreference vocabulary)', async () => {
    render(<QualityPicker kind="receiver" value="medium" onPick={() => {}} context="panel" />);
    await userEvent.click(screen.getByTestId('quality-trigger-panel'));
    const options = screen.getAllByTestId('quality-option-panel');
    expect(options.map((o) => o.getAttribute('data-quality'))).toEqual([
      'high',
      'medium',
      'low',
    ]);
    expect(screen.getByTestId('quality-trigger-panel').getAttribute('aria-label')).toBe(
      'Max video quality: Medium',
    );
  });
});

// -- selection + keyboard ----------------------------------------------------------

describe('QualityPicker — selection', () => {
  it('marks the current tier aria-checked + Current chip (non-color)', async () => {
    render(<QualityPicker kind="sender" source="camera" value="low" onPick={() => {}} context="panel" />);
    await userEvent.click(screen.getByTestId('quality-trigger-panel'));
    const options = screen.getAllByTestId('quality-option-panel');
    expect(options[0]!.getAttribute('aria-checked')).toBe('true');
    expect(options[1]!.getAttribute('aria-checked')).toBe('false');
    expect(options[0]!.contains(screen.getByTestId('quality-current-panel'))).toBe(true);
  });

  it('keyboard: arrows move, Enter picks, Escape closes and restores focus', async () => {
    const onPick = vi.fn();
    render(<QualityPicker kind="sender" source="camera" value="high" onPick={onPick} context="panel" />);
    const trigger = screen.getByTestId('quality-trigger-panel');
    await userEvent.click(trigger);
    const options = screen.getAllByTestId('quality-option-panel');
    expect(document.activeElement).toBe(options[2]); // focus starts on current
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(options[1]);
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('medium');
    expect(screen.queryByTestId('quality-menu-panel')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('quality-menu-panel')).toBeNull();
  });
});

// -- VM20 pre-disabled ---------------------------------------------------------------

describe('QualityPicker — VM20 pre-disabled with explanatory title', () => {
  it('renders visible-but-disabled with the caller\'s explanatory title', () => {
    render(
      <QualityPicker
        kind="sender"
        source="screen"
        value="medium"
        onPick={() => {}}
        context="panel"
        disabled
        disabledTitle="Screen sharing is disabled in this channel"
      />,
    );
    const trigger = screen.getByTestId('quality-trigger-panel');
    expect(trigger.getAttribute('disabled')).not.toBeNull(); // native pre-disabled
    expect(trigger.getAttribute('title')).toBe('Screen sharing is disabled in this channel');
  });

  it('a disabled picker never opens its menu (no enabled-buttons-that-403)', async () => {
    render(
      <QualityPicker
        kind="receiver"
        value="high"
        onPick={() => {}}
        context="panel"
        disabled
        disabledTitle="You are offline — quality controls are unavailable"
      />,
    );
    await userEvent.click(screen.getByTestId('quality-trigger-panel'), { pointerEventsCheck: 0 });
    expect(screen.queryByTestId('quality-menu-panel')).toBeNull();
  });

  it('the enabled title names the current tier (no stale disabled copy)', () => {
    render(<QualityPicker kind="sender" source="camera" value="high" onPick={() => {}} context="panel" />);
    expect(screen.getByTestId('quality-trigger-panel').getAttribute('title')).toBe(
      'Camera quality: 720p · 30 fps',
    );
  });
});

// -- axe -------------------------------------------------------------------------

describe('QualityPicker — axe', () => {
  it('zero violations: enabled open, enabled closed, pre-disabled (desktop)', async () => {
    const onPick = () => {};
    const { container } = render(
      <QualityPicker kind="sender" source="camera" value="high" onPick={onPick} context="panel" />,
    );
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.click(screen.getByTestId('quality-trigger-panel'));
    expect(await axe(container)).toHaveNoViolations();

    cleanup();
    const disabled = render(
      <QualityPicker
        kind="sender"
        source="screen"
        value="medium"
        onPick={onPick}
        context="panel"
        disabled
        disabledTitle="Screen sharing is disabled in this channel"
      />,
    );
    expect(await axe(disabled.container)).toHaveNoViolations();
  });

  it('zero violations on the mobile composition (receiver picker)', async () => {
    const { container } = render(
      <QualityPicker kind="receiver" value="low" onPick={() => {}} context="dm" />,
    );
    await userEvent.click(screen.getByTestId('quality-trigger-dm'));
    expect(await axe(container)).toHaveNoViolations();
  });
});
