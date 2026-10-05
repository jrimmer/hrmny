/**
 * @cytale/web — the shared glyphs (plan 7.7).
 *
 * `PhoneIcon` and `Spinner` were each declared verbatim in more than one
 * surface; these pin the contract those copies relied on, so a future edit to
 * the one definition cannot silently change a call site's rendering:
 *   - PhoneIcon is the FILLED handset at the shared 16 default, with `size`
 *     covering the 14/16/18 call sites and `className` carrying CallSlot's
 *     `.call-slot-icon`;
 *   - Spinner is the `animate-spin` ring under the caller's testid (the only
 *     thing that ever differed between the two copies).
 *
 * The declaration-uniqueness half of 7.7 lives in
 * `sharedPrimitives.dedup.test.ts` (a source scan, not a render).
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PhoneIcon, Spinner } from '../icons.js';

afterEach(cleanup);

describe('PhoneIcon', () => {
  it('renders the filled 24-grid handset at the shared default size (16)', () => {
    const { container } = render(<PhoneIcon />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    // The filled silhouette is the point — stroke-2 would change the weight.
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.querySelector('path')!.getAttribute('d')).toMatch(/^M6\.6 10\.8/);
  });

  it('honours size (14 CallSlot/CallPanel, 18 MobileTopbar, 16 CallPanel header)', () => {
    for (const size of [14, 16, 18]) {
      const { container } = render(<PhoneIcon size={size} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('width')).toBe(String(size));
      expect(svg.getAttribute('height')).toBe(String(size));
      cleanup();
    }
  });

  it("forwards className — CallSlot's layout class rides the shared glyph", () => {
    const { container } = render(<PhoneIcon size={14} className="call-slot-icon" />);
    expect(container.querySelector('svg')!.getAttribute('class')).toBe('call-slot-icon');
  });
});

describe('Spinner', () => {
  it("renders the animate-spin ring under the caller's testid", () => {
    const { container } = render(<Spinner testId="call-spinner" />);
    const ring = container.querySelector('[data-testid="call-spinner"]') as HTMLElement;
    expect(ring).toBeTruthy();
    expect(ring.getAttribute('aria-hidden')).toBe('true');
    // The animation mechanism both copies already used — Tailwind's utility.
    expect(ring.className).toContain('animate-spin');
    expect(ring.className).toContain('rounded-full');
    expect(ring.className).toContain('border-text-muted');
  });

  it("keeps each surface's own testid distinct", () => {
    const { container } = render(<Spinner testId="dm-call-spinner" />);
    expect(container.querySelector('[data-testid="dm-call-spinner"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="call-spinner"]')).toBeNull();
  });
});
