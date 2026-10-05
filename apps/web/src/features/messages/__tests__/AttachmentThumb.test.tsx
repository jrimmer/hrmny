/**
 * AttachmentThumb (#56) — inline staged-image thumbnails with the shared
 * lightbox clickthrough, and MessageItem's sent-image preview wiring.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import { AttachmentThumb } from '../AttachmentThumb.js';

afterEach(() => cleanup());

function makeImage(name = 'cat.png'): File {
  return new File([new Uint8Array([0x89, 0x50])], name, { type: 'image/png' });
}

describe('AttachmentThumb', () => {
  it('renders the local object URL immediately (before any upload resolves)', () => {
    render(
      <AttachmentThumb file={makeImage()} status="uploading" uploadedUrl={null} onRemove={vi.fn()} />,
    );
    const img = screen.getByTestId('attachment-thumb-preview').querySelector('img');
    expect(img?.getAttribute('src')).toMatch(/^blob:/);
    expect(screen.getByTestId('attachment-thumb-uploading')).toBeTruthy();
  });

  it('swaps to the served descriptor URL once done', () => {
    render(
      <AttachmentThumb
        file={makeImage()}
        status="done"
        uploadedUrl="/api/v1/attachments/aa"
        onRemove={vi.fn()}
      />,
    );
    const img = screen.getByTestId('attachment-thumb-preview').querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/v1/attachments/aa');
    expect(screen.queryByTestId('attachment-thumb-uploading')).toBeNull();
  });

  it('fits the WHOLE image inside the square (object-contain, not cover)', () => {
    render(
      <AttachmentThumb
        file={makeImage('wide shot.png')}
        status="done"
        uploadedUrl="/api/v1/attachments/aa"
        onRemove={vi.fn()}
      />,
    );
    const img = screen.getByTestId('attachment-thumb-preview').querySelector('img')!;
    // `object-cover` cropped anything that was not square (owner's report,
    // 2026-09-18: "not completely in the bounding box"). The preview is a
    // preview — it must show the whole frame.
    expect(img.className).toContain('object-contain');
    expect(img.className).not.toContain('object-cover');
  });

  it('error state overlays the thumb and keeps it removable', async () => {
    const onRemove = vi.fn();
    render(
      <AttachmentThumb
        file={makeImage()}
        status="error"
        uploadedUrl={null}
        error="File type not allowed."
        onRemove={onRemove}
      />,
    );
    expect(screen.getByTestId('attachment-thumb-error').textContent).toContain('not allowed');
    await userEvent.setup().click(screen.getByTestId('attachment-thumb-remove'));
    expect(onRemove).toHaveBeenCalled();
  });

  it('click opens the lightbox with the full image; close returns to the tray', async () => {
    render(
      <AttachmentThumb
        file={makeImage('wide shot.png')}
        status="done"
        uploadedUrl="/api/v1/attachments/aa"
        onRemove={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByTestId('attachment-thumb-preview'));

    const lightbox = screen.getByTestId('image-lightbox');
    expect(lightbox).toBeTruthy();
    expect(screen.getByTestId('image-lightbox-img').getAttribute('src')).toBe(
      '/api/v1/attachments/aa',
    );
    expect(screen.getByTestId('image-lightbox-name').textContent).toBe('wide shot.png');

    await userEvent.setup().click(screen.getByTestId('image-lightbox-close'));
    await waitFor(() => expect(screen.queryByTestId('image-lightbox')).toBeNull());
  });

  it('keyboard path: Enter opens the lightbox, Delete removes', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachmentThumb
        file={makeImage('kb.png')}
        status="done"
        uploadedUrl="/api/v1/attachments/aa"
        onRemove={onRemove}
      />,
    );
    const thumb = screen.getByTestId('attachment-thumb-preview');
    thumb.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('image-lightbox')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('image-lightbox')).toBeNull());

    await user.keyboard('{Delete}');
    expect(onRemove).toHaveBeenCalledTimes(1);
    await user.keyboard('{Backspace}');
    expect(onRemove).toHaveBeenCalledTimes(2);
  });

  it('removal unmounts the thumb and revokes its object URL', () => {
    const createSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test-captured-url');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    try {
      const { unmount } = render(
        <AttachmentThumb file={makeImage()} status="uploading" uploadedUrl={null} onRemove={vi.fn()} />,
      );
      expect(createSpy).toHaveBeenCalledTimes(1);
      unmount(); // what remove/send/channel-switch all do to a thumb
      expect(revokeSpy).toHaveBeenCalledWith('blob:test-captured-url');
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it('the open lightbox has no axe violations', async () => {
    render(
      <AttachmentThumb
        file={makeImage('axe.png')}
        status="done"
        uploadedUrl="/api/v1/attachments/aa"
        onRemove={vi.fn()}
      />,
    );
    await userEvent.setup().click(screen.getByTestId('attachment-thumb-preview'));
    expect(screen.getByTestId('image-lightbox')).toBeTruthy();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('has no axe violations across its states', async () => {
    const { container } = render(
      <ul aria-label="Staged attachments">
        <AttachmentThumb
          file={makeImage()}
          status="done"
          uploadedUrl="/api/v1/attachments/aa"
          onRemove={vi.fn()}
        />
      </ul>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
