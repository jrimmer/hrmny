/**
 * ImageCropDialog (#48) — staging, pan/zoom controls, confirm/cancel.
 * jsdom has no canvas 2d: the confirm path's canvas half is pinned by
 * mocking toBlob + getContext; the no-canvas degradation (original file)
 * is also covered.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { ImageCropDialog } from '../ImageCropDialog.js';

afterEach(() => cleanup());

// jsdom has no object-URL implementation.
beforeEach(() => {
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = () => 'blob:mock';
    URL.revokeObjectURL = () => undefined;
  }
});

function makeFile(name = 'me.png', type = 'image/png'): File {
  return new File([new Uint8Array([0x89, 0x50])], name, { type });
}

/** The dialog's <img> needs natural dims to become ready. */
function primeImage() {
  const img = screen.getByTestId('crop-image') as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { value: 800 });
  Object.defineProperty(img, 'naturalHeight', { value: 400 });
  fireEvent.load(img);
}

describe('ImageCropDialog', () => {
  it('renders the masked viewport and stays inert until the image loads', () => {
    render(
      <ImageCropDialog
        file={makeFile()}
        mask="circle"
        title="Position your avatar"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('crop-dialog')).toBeTruthy();
    expect(screen.getByTestId('crop-viewport').className).toContain('rounded-full');
    expect((screen.getByTestId('crop-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('becomes operable once the image loads; zoom buttons change the transform', async () => {
    render(
      <ImageCropDialog file={makeFile()} mask="rounded" title="T" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    primeImage();
    const confirm = screen.getByTestId('crop-confirm') as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));

    const img = screen.getByTestId('crop-image') as HTMLImageElement;
    const w0 = img.style.width;
    await userEvent.setup().click(screen.getByTestId('crop-zoom-in'));
    expect(img.style.width).not.toBe(w0);
  });

  it('keyboard: arrows pan and + zooms', async () => {
    render(
      <ImageCropDialog file={makeFile()} mask="circle" title="T" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    primeImage();
    await waitFor(() => expect((screen.getByTestId('crop-confirm') as HTMLButtonElement).disabled).toBe(false));

    const img = screen.getByTestId('crop-image') as HTMLImageElement;
    const left0 = img.style.left;
    fireEvent.keyDown(screen.getByTestId('crop-dialog'), { key: 'ArrowLeft' });
    expect(img.style.left).not.toBe(left0);

    const w0 = img.style.width;
    fireEvent.keyDown(screen.getByTestId('crop-dialog'), { key: '+' });
    expect(img.style.width).not.toBe(w0);
  });

  it('confirm exports the cropped square through canvas (toBlob mocked)', async () => {
    const onConfirm = vi.fn();
    const drawImage = vi.fn();
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const toBlob = vi.fn((cb: (b: Blob | null) => void) => cb(blob));

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      { drawImage } as unknown as CanvasRenderingContext2D,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      toBlob as unknown as typeof HTMLCanvasElement.prototype.toBlob,
    );

    render(<ImageCropDialog file={makeFile('avatar.png')} mask="circle" title="T" onConfirm={onConfirm} onCancel={vi.fn()} />);
    primeImage();
    await userEvent.setup().click(screen.getByTestId('crop-confirm'));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const [out, name] = onConfirm.mock.calls[0]!;
    expect((out as Blob).type).toBe('image/png');
    expect(name).toBe('avatar-crop.png');
    // The bounded export: canvas side is min(512, source crop side).
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      0,
      0,
      400, // 800x400 at cover 240: crop side is 400 source px < 512 cap
      400,
    );
    vi.restoreAllMocks();
  });

  it('confirm without canvas support degrades to the original file', async () => {
    const onConfirm = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    render(<ImageCropDialog file={makeFile('big.png')} mask="circle" title="T" onConfirm={onConfirm} onCancel={vi.fn()} />);
    primeImage();
    await userEvent.setup().click(screen.getByTestId('crop-confirm'));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const [out, name] = onConfirm.mock.calls[0]!;
    expect(name).toBe('big.png');
    expect((out as File).name).toBe('big.png');
    vi.restoreAllMocks();
  });

  it('cancel discards: onCancel fires, onConfirm never does', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ImageCropDialog file={makeFile()} mask="circle" title="T" onConfirm={onConfirm} onCancel={onCancel} />);
    primeImage();
    await userEvent.setup().click(screen.getByTestId('crop-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('has no axe violations once ready', async () => {
    const { container } = render(
      <ImageCropDialog file={makeFile()} mask="circle" title="Position your avatar" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    primeImage();
    await waitFor(() => expect((screen.getByTestId('crop-confirm') as HTMLButtonElement).disabled).toBe(false));
    expect(await axe(container)).toHaveNoViolations();
  });
});
