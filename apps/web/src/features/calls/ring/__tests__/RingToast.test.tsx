/**
 * @cytale/web — RingToast presentational tests (calls plan U11).
 *
 * States-first DoD on the toast surface: axe zero violations (single toast,
 * stacked toasts, subtle variant), full keyboard operability (Join/Dismiss
 * are real buttons reached by Tab and activated by Enter/Space), and the
 * visible equivalents the WCAG contract requires (channel name, caller,
 * actions).
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

import { RingToast, type RingToastProps } from '../RingToast.js';
import type { RingToastState } from '../ringReducer.js';

function toast(overrides: Partial<RingToastState> = {}): RingToastState {
  return {
    channelId: '7500000000000000100',
    callId: '7500000000000000091',
    fromUser: '7500000000000000002',
    rangAt: Date.now(),
    subtle: false,
    ...overrides,
  };
}

function props(overrides: Partial<RingToastProps> = {}): RingToastProps {
  return {
    toast: toast(),
    channelName: 'general',
    callerName: 'alice',
    onJoin: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

// #150: the card is a Radix Toast Root — it must sit inside a Provider
// (the app's region provides one; standalone card tests provide their own).
import { ToastProvider, ToastViewport } from '../../../../components/shadcn/toast.js';
function renderCard(ui: React.ReactElement) {
  // Provider + a viewport (Radix portals each card into the registered
  // viewport — a toast without one renders null).
  return render(
    <ToastProvider swipeDirection="right">
      <ToastViewport data-testid="probe-viewport" />
      {ui}
    </ToastProvider>,
  );
}

describe('RingToast (content + a11y)', () => {
  it('shows the channel name, the caller, and enabled Join/Dismiss buttons', () => {
    renderCard(<RingToast {...props()} />);
    const title = screen.getByTestId('ring-toast-title');
    expect(title.textContent).toContain('general');
    expect(title.textContent).toContain('alice');
    const join = screen.getByTestId('ring-toast-join') as HTMLButtonElement;
    const dismiss = screen.getByTestId('ring-toast-dismiss') as HTMLButtonElement;
    expect(join.disabled).toBe(false);
    expect(dismiss.disabled).toBe(false);
    expect(join.textContent).toBe('Join');
    expect(dismiss.textContent).toBe('Dismiss');
  });

  it('axe: zero violations (audible, subtle, and stacked variants)', async () => {
    const { container } = renderCard(
      <div>
        <RingToast {...props()} />
        <RingToast
          {...props({
            toast: toast({ subtle: true }),
          })}
        />
        <RingToast
          {...props({
            toast: toast({ channelId: '7500000000000000200', callId: '7500000000000000092' }),
            channelName: 'random',
          })}
        />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('carries the explicit no-sound note on the subtle (in-call) variant', () => {
    renderCard(<RingToast {...props({ toast: toast({ subtle: true }) })} />);
    expect(screen.getByTestId('ring-toast-subtle-note')).not.toBeNull();
  });
});

describe('RingToast (keyboard operability)', () => {
  it('Tab reaches Join then Dismiss; Enter activates each', async () => {
    const onJoin = vi.fn();
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    renderCard(<RingToast {...props({ onJoin, onDismiss })} />);

    // #150: Radix's toast keyboard model — the viewport's Tab lands the CARD
    // first (its roving focus; the card is announced), then the actions.
    await user.tab(); // first stop = the card itself
    expect(document.activeElement).toBe(screen.getByTestId('ring-toast'));
    await user.tab(); // Join
    expect(document.activeElement).toBe(screen.getByTestId('ring-toast-join'));
    await user.keyboard('{Enter}');
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    await user.tab(); // Dismiss
    expect(document.activeElement).toBe(screen.getByTestId('ring-toast-dismiss'));
    await user.keyboard('{Enter}');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledTimes(1); // not re-fired
  });

  it('Space activates the focused action too', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    renderCard(<RingToast {...props({ onDismiss })} />);
    await user.tab(); // the card (Radix roving)
    await user.tab(); // Join
    await user.tab(); // Dismiss
    await user.keyboard(' ');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
