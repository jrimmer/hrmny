/**
 * @cytale/web — ShareSwitcher tests (calls V2 plan U5a, VM4/VM21/VM22).
 *
 * The render gate (only >1 live share), the house keyboard menu contract
 * (arrows move, Enter/Space select, Escape closes + focus returns, outside
 * click closes, Tab dismisses), non-color selection state (aria-checked +
 * "Showing"), the VM22 mode footer, and VM21's polite switch announcement.
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

import { ShareSwitcher, type SwitcherShare } from '../ShareSwitcher.js';
import { mobileWidthState } from '../../../../test/setup.js';

afterEach(() => {
  cleanup();
  mobileWidthState.mobile = false;
});

const SHARES: SwitcherShare[] = [
  { shareId: 'sh1', presenterName: 'Ada', sourceLabel: 'Entire screen' },
  { shareId: 'sh2', presenterName: 'Grace', sourceLabel: 'Window — Reports' },
  { shareId: 'sh3', presenterName: 'Linus' },
];

function renderSwitcher(props: Partial<Parameters<typeof ShareSwitcher>[0]> = {}) {
  return render(
    <ShareSwitcher
      shares={SHARES}
      activeShareId="sh1"
      mode="follow-recent"
      onSelect={() => {}}
      {...props}
    />,
  );
}

// -- render gate -----------------------------------------------------------------

describe('ShareSwitcher — render gate (VM4)', () => {
  it('renders nothing with zero or one live share', () => {
    const { container, rerender } = render(
      <ShareSwitcher shares={[]} activeShareId={null} mode="follow-recent" onSelect={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    rerender(
      <ShareSwitcher
        shares={[SHARES[0]!]}
        activeShareId="sh1"
        mode="follow-recent"
        onSelect={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders for multiple shares with the live count on the trigger', () => {
    renderSwitcher();
    const trigger = screen.getByTestId('share-switcher-trigger');
    expect(trigger.getAttribute('aria-label')).toBe('Switch screen share (3 live)');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});

// -- menu ------------------------------------------------------------------------

describe('ShareSwitcher — menu', () => {
  it('opens on trigger and lists every share by presenter + source', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    const menu = screen.getByTestId('share-switcher-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    const options = screen.getAllByTestId('share-switcher-option');
    expect(options).toHaveLength(3);
    expect(options[0]!.textContent).toContain('Ada');
    expect(options[0]!.textContent).toContain('Entire screen');
    expect(options[1]!.textContent).toContain('Window — Reports');
    expect(options[2]!.textContent).toContain('Linus'); // default "screen" label
  });

  it('marks the staged share with aria-checked AND the Showing chip (non-color)', async () => {
    renderSwitcher({ activeShareId: 'sh2' });
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    const options = screen.getAllByTestId('share-switcher-option');
    expect(options[0]!.getAttribute('aria-checked')).toBe('false');
    expect(options[1]!.getAttribute('aria-checked')).toBe('true');
    expect(options[1]!.contains(screen.getByTestId('share-switcher-showing'))).toBe(true);
    expect(screen.queryByTestId('share-switcher-showing')).toBeTruthy();
  });

  it('surfaces the VM22 mode in the footer text', async () => {
    const { rerender } = renderSwitcher({ mode: 'follow-recent' });
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    expect(screen.getByTestId('share-switcher-mode').textContent).toMatch(
      /follows the most recent share/i,
    );

    rerender(
      <ShareSwitcher
        shares={SHARES}
        activeShareId="sh1"
        mode="viewer-selected"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('share-switcher-mode').textContent).toMatch(/your choice/i);

    rerender(
      <ShareSwitcher
        shares={SHARES}
        activeShareId="sh1"
        mode="pinned"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('share-switcher-mode').textContent).toMatch(/pinned/i);
  });
});

// -- house keyboard contract -------------------------------------------------------

describe('ShareSwitcher — house keyboard menu contract (VM21)', () => {
  it('arrows move focus; focus starts on the active share', async () => {
    renderSwitcher({ activeShareId: 'sh2' });
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    const options = screen.getAllByTestId('share-switcher-option');
    expect(document.activeElement).toBe(options[1]);

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(options[2]);

    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(options[1]);
  });

  it('Enter selects (onSelect with the shareId), closes, and returns focus to the trigger', async () => {
    const onSelect = vi.fn();
    renderSwitcher({ onSelect });
    const trigger = screen.getByTestId('share-switcher-trigger');
    await userEvent.click(trigger);
    await userEvent.keyboard('{Enter}');
    // Focus starts on the active share (sh1) — Enter picks it.
    expect(onSelect).toHaveBeenCalledWith('sh1');
    expect(screen.queryByTestId('share-switcher-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Space selects too; arrows wrap around the list', async () => {
    const onSelect = vi.fn();
    renderSwitcher({ activeShareId: 'sh3', onSelect });
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    const options = screen.getAllByTestId('share-switcher-option');
    expect(document.activeElement).toBe(options[2]);
    await userEvent.keyboard('{ArrowDown}'); // wraps to the first
    expect(document.activeElement).toBe(options[0]);
    await userEvent.keyboard('{ }');
    expect(onSelect).toHaveBeenCalledWith('sh1');
  });

  it('Escape closes and returns focus to the trigger', async () => {
    renderSwitcher();
    const trigger = screen.getByTestId('share-switcher-trigger');
    await userEvent.click(trigger);
    expect(screen.getByTestId('share-switcher-menu')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('share-switcher-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab escaping the menu dismisses it', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    await userEvent.keyboard('{Tab}');
    expect(screen.queryByTestId('share-switcher-menu')).toBeNull();
  });

  it('outside click closes without selecting', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    await userEvent.click(document.body);
    expect(screen.queryByTestId('share-switcher-menu')).toBeNull();
  });
});

// -- VM21 announcement -------------------------------------------------------------

describe('ShareSwitcher — live region (VM21)', () => {
  it('polite region names the share now showing', () => {
    renderSwitcher({ activeShareId: 'sh1' });
    const region = screen.getByTestId('share-switcher-announce');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe("Showing Ada's Entire screen");
  });
});

// -- axe -------------------------------------------------------------------------

describe('ShareSwitcher — axe', () => {
  it('zero violations closed and open (desktop + mobile width)', async () => {
    const { container } = renderSwitcher();
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    expect(await axe(container)).toHaveNoViolations();

    cleanup();
    mobileWidthState.mobile = true;
    const mobile = renderSwitcher();
    await userEvent.click(screen.getByTestId('share-switcher-trigger'));
    expect(await axe(mobile.container)).toHaveNoViolations();
  });
});
