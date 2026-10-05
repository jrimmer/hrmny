/**
 * UserPanel — the gear is a real toggle now: aria-expanded, active state,
 * and the settings callback.
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

import { UserPanel } from '../UserPanel.js';

afterEach(() => cleanup());

const user = { id: '9001', name: 'jordan', handle: '@jordan', status: 'online' as const };

describe('UserPanel settings gear', () => {
  it('renders as a labelled toggle and reports clicks', async () => {
    const onToggleSettings = vi.fn();
    render(
      <UserPanel user={user} selfStatus="online" onToggleSettings={onToggleSettings} />,
    );

    const gear = screen.getByTestId('user-settings-toggle');
    expect(gear.getAttribute('aria-label')).toBe('User settings');
    expect(gear.getAttribute('aria-expanded')).toBeNull();

    await userEvent.setup().click(gear);
    expect(onToggleSettings).toHaveBeenCalled();
  });

  it('reflects the open state (aria-expanded + active)', () => {
    render(
      <UserPanel
        user={user}
        selfStatus="online"
        settingsOpen
        onToggleSettings={() => undefined}
      />,
    );
    const gear = screen.getByTestId('user-settings-toggle');
    expect(gear.getAttribute('aria-expanded')).toBe('true');
    expect(gear.getAttribute('data-active')).toBe('true');
  });

  it('works without a settings handler (default closed)', () => {
    render(<UserPanel user={user} selfStatus="online" />);
    expect(screen.getByTestId('user-settings-toggle').getAttribute('aria-expanded')).toBeNull();
  });
});

// -- user-panel mic status (user-directed 2026-09-07) --------------------------

import { setCallEngineForTests, type CallEngine } from '../../../features/calls/useCallMedia.js';

function micStatusEngine(opts: {
  status: string;
  channelId?: string | null;
  muted?: boolean;
  speaking?: string[];
}): CallEngine {
  const snapshot = {
    voice: { status: opts.status, pcConnected: true, micGranted: true, notice: null },
    channelId: opts.channelId ?? null,
    muted: opts.muted ?? false,
    deafened: false,
    listenOnly: false,
    publishing: { camera: false, screen: false, screen_audio: false },
  };
  const speaking = new Set(opts.speaking ?? []);
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    speakingSubscribe: () => () => undefined,
    getSpeaking: () => speaking,
  } as unknown as CallEngine;
}

describe('UserPanel — mic status', () => {
  const user = { name: 'Ada', handle: '@ada', id: '9001', status: 'online' as const };

  afterEach(() => {
    setCallEngineForTests(null);
  });

  it('renders inert out of call (no in-call state, honest label)', () => {
    setCallEngineForTests(micStatusEngine({ status: 'idle' }));
    render(<UserPanel user={user} selfStatus="online" />);
    const mic = screen.getByTestId('user-panel-mic');
    expect(mic.getAttribute('data-in-call')).toBeNull();
    expect(mic.getAttribute('aria-label')).toBe('Microphone inactive');
  });

  it('goes green while the AM5 monitor hears the local mic (data-hearing)', () => {
    setCallEngineForTests(
      micStatusEngine({ status: 'connected', channelId: 'c-1', speaking: ['9001'] }),
    );
    render(<UserPanel user={user} selfStatus="online" />);
    const mic = screen.getByTestId('user-panel-mic');
    expect(mic.getAttribute('data-hearing')).toBe('true');
    expect(mic.getAttribute('aria-label')).toBe('Hrmny is hearing you');
  });

  it('stays neutral in call but silent, and marks mute distinctly', () => {
    setCallEngineForTests(
      micStatusEngine({ status: 'connected', channelId: 'c-1' }),
    );
    render(<UserPanel user={user} selfStatus="online" />);
    expect(screen.getByTestId('user-panel-mic').getAttribute('aria-label')).toBe(
      'Microphone live',
    );

    cleanup();
    setCallEngineForTests(
      micStatusEngine({ status: 'connected', channelId: 'c-1', muted: true, speaking: ['9001'] }),
    );
    render(<UserPanel user={user} selfStatus="online" />);
    const mic = screen.getByTestId('user-panel-mic');
    // Mute wins over speaking: a disabled track renders silence, so the
    // monitor cannot report hearing — the mark explains WHY.
    expect(mic.getAttribute('data-muted')).toBe('true');
    expect(mic.getAttribute('data-hearing')).toBeNull();
    expect(mic.getAttribute('aria-label')).toBe('Microphone muted');
  });

  it('has no axe violations in the hearing-you state', async () => {
    setCallEngineForTests(
      micStatusEngine({ status: 'connected', channelId: 'c-1', speaking: ['9001'] }),
    );
    const { container } = render(<UserPanel user={user} selfStatus="online" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
