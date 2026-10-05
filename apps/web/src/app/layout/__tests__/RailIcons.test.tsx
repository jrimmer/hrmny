/**
 * @cytale/web — RailIcons' Escape: it closes the open column, and steps aside
 * when a surface inside the column (the member profile overlay) or a layer
 * above has already claimed the key — one Escape, one step back.
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RailIcons } from '../RailIcons.js';

afterEach(cleanup);

describe('RailIcons — Escape', () => {
  it('closes the open column', () => {
    const onSelect = vi.fn();
    render(<RailIcons mode="calls" onSelect={onSelect} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onSelect).toHaveBeenCalledWith('calls');
  });

  it('steps aside when a surface already handled the Escape', () => {
    const onSelect = vi.fn();
    render(<RailIcons mode="members" onSelect={onSelect} />);
    // The profile overlay's listener: registered AFTER the column opened, on
    // document — it still runs first, because the column listens on window.
    const claim = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener('keydown', claim);
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', claim);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does nothing while the column is closed', () => {
    const onSelect = vi.fn();
    render(<RailIcons mode={null} onSelect={onSelect} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
