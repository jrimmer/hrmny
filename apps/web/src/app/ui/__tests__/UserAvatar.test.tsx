/**
 * UserAvatar — the one identity circle: image when src loads, hue tile
 * otherwise, load-failure fallback, and re-attempt after src changes.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Avatar } from '../UserAvatar.js';
import { resetImageFailureMemoForTests } from '../useRetryingImage.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // The failure memo is module state shared by every avatar in the app — reset
  // it or one test's broken hash suppresses the next test's image.
  resetImageFailureMemoForTests();
});

function tileAt(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="avatar-host"]');
}

describe('UserAvatar', () => {
  it('renders the initials tile without an img when src is absent', () => {
    const { container } = render(
      <Avatar id="9001" name="jordan" data-testid="avatar-host" />,
    );
    const host = tileAt(container)!;
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('JO');
    // jsdom normalizes hsl() to rgb() — assert a tile background exists.
    expect(host.style.background).toMatch(/^(rgb|hsl)\(/);
  });

  it('renders first+last initials for a two-part display name', () => {
    // The tile's rule is one helper (avatar.ts); this pins the wiring, not the
    // rule — a lone 'J' or a raw 'MA' here would mean the component stopped
    // asking the helper.
    const { container } = render(
      <Avatar id="9002" name="Mia Helper" data-testid="avatar-host" />,
    );
    expect(tileAt(container)!.textContent).toBe('MH');
  });

  it('renders the image when src is set', () => {
    const { container } = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );
    const img = tileAt(container)!.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/v1/attachments/aa');
  });

  it('falls back to the tile once the retries are exhausted (stale hash)', async () => {
    vi.useFakeTimers();
    const { container } = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );
    const host = tileAt(container)!;

    // A content-addressed URL is retried (with a cache bust) before the tile
    // is pinned — see useRetryingImage.
    for (let i = 0; i < 3; i++) {
      fireEvent.error(host.querySelector('img')!);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_300);
      });
    }

    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('JO');
  });


  it('the pinned tile is a retry button: click re-attempts the SAME src (#47)', async () => {
    vi.useFakeTimers();
    const { container } = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );
    const host = tileAt(container)!;

    for (let i = 0; i < 3; i++) {
      fireEvent.error(host.querySelector('img')!);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_300);
      });
    }
    expect(host.querySelector('img')).toBeNull();
    expect(host.getAttribute('role')).toBe('button');

    // The manual retry clears the shared failure memo and restarts the
    // cycle at the same URL — the byte-identical re-upload case.
    fireEvent.click(host);
    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toContain('/api/v1/attachments/aa');
  });

  it('re-attempts the image after a failure once src changes (re-upload)', () => {
    const { rerender, container } = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );
    const host = tileAt(container)!;

    // Fail the first load (a retry is pending)…
    fireEvent.error(host.querySelector('img')!);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/v1/attachments/aa');

    // …a re-upload changes src, which starts a fresh cycle at the new URL.
    rerender(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/bb" data-testid="avatar-host" />,
    );
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/v1/attachments/bb');
  });
});

describe('UserAvatar — transient load failures', () => {
  it('retries with a cache-busting URL before pinning the fallback tile', async () => {
    vi.useFakeTimers();
    const { container } = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );

    const first = container.querySelector('img')!;
    expect(first.getAttribute('src')).toBe('/api/v1/attachments/aa');

    // Transient 404 (a blob landing after its metadata): retry, not tile.
    fireEvent.error(first);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/v1/attachments/aa?retry=1',
    );

    fireEvent.error(container.querySelector('img')!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/v1/attachments/aa?retry=2',
    );

    // Third failure exhausts the budget and the tile takes over.
    fireEvent.error(container.querySelector('img')!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    expect(container.querySelector('img')).toBeNull();
    expect(tileAt(container)?.textContent).toBe('JO');
  });
});

describe('UserAvatar — broken-hash fan-out', () => {
  it('renders the fallback without requesting a URL a sibling just failed', () => {
    const first = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );
    // One failure is enough to record it — the retries still run for THIS
    // instance, but a fresh instance must not start its own three.
    fireEvent.error(first.container.querySelector('img')!);
    cleanup();

    const second = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );
    expect(second.container.querySelector('img')).toBeNull();
    expect(tileAt(second.container)?.textContent).toBe('JO');
  });

  it('forgets the failure after the TTL, so a later mount retries', async () => {
    vi.useFakeTimers();
    const first = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );
    fireEvent.error(first.container.querySelector('img')!);
    cleanup();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });

    const second = render(
      <Avatar id="9001" name="jordan" src="/api/v1/attachments/aa" data-testid="avatar-host" />,
    );
    expect(second.container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/v1/attachments/aa',
    );
  });
});
