/**
 * useFileDropZone — depth-counted drag overlay + file extraction.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFileDropZone } from '../useFileDropZone.js';

afterEach(() => cleanup());

function Host({ onFiles }: { onFiles: (files: File[]) => void }) {
  const { isDragging, dropHandlers } = useFileDropZone(onFiles);
  return (
    <div data-testid="zone" data-dragging={isDragging || undefined} {...dropHandlers}>
      zone
      {isDragging ? <div data-testid="overlay">overlay</div> : null}
    </div>
  );
}

// testing-library's event init attaches the provided keys onto the fired
// event — jsdom's DragEvent has no dataTransfer of its own.
function dragEnter(el: Element, types: string[]) {
  fireEvent.dragEnter(el, { dataTransfer: { types } });
}

function dragLeave(el: Element, types: string[]) {
  fireEvent.dragLeave(el, { dataTransfer: { types } });
}

function drop(el: Element, files: File[]) {
  fireEvent.drop(el, { dataTransfer: { types: ['Files'], files } });
}

describe('useFileDropZone', () => {
  it('shows the overlay while a file drag enters and clears when it fully leaves', () => {
    render(<Host onFiles={vi.fn()} />);
    const zone = screen.getByTestId('zone');

    // Nested enter/leave pairs never flicker the overlay: the counter must
    // reach zero (two enters, one leave, still up; second leave, down).
    act(() => {
      dragEnter(zone, ['Files']);
      dragEnter(zone, ['Files']);
    });
    expect(zone.getAttribute('data-dragging')).toBe('true');

    act(() => dragLeave(zone, ['Files']));
    expect(zone.getAttribute('data-dragging')).toBe('true');

    act(() => dragLeave(zone, ['Files']));
    expect(zone.getAttribute('data-dragging')).toBeNull();
    expect(screen.queryByTestId('overlay')).toBeNull();
  });

  it('ignores non-file drags (text selections never trip the overlay)', () => {
    render(<Host onFiles={vi.fn()} />);
    const zone = screen.getByTestId('zone');
    act(() => dragEnter(zone, ['text/plain']));
    expect(zone.getAttribute('data-dragging')).toBeNull();
  });

  it('drop hands the files over and clears the overlay; an empty drop reports nothing', () => {
    const onFiles = vi.fn();
    render(<Host onFiles={onFiles} />);
    const zone = screen.getByTestId('zone');

    const file = new File(['bits'], 'cat.png', { type: 'image/png' });
    act(() => dragEnter(zone, ['Files']));
    expect(zone.getAttribute('data-dragging')).toBe('true');

    act(() => drop(zone, [file]));
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(zone.getAttribute('data-dragging')).toBeNull();

    act(() => drop(zone, []));
    expect(onFiles).toHaveBeenCalledTimes(1);
  });
});
