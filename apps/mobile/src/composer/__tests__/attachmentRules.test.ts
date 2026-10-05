/**
 * Attachment prefilter contract (plan 004 M7, R10).
 *
 * The rules mirror `apps/server/config/config.exs` `:attachments`: a blocked
 * type or an oversize file is refused client-side with a readable message,
 * before any bytes are uploaded.
 */
import {
  ALLOWED_UPLOAD_EXT,
  ALLOWED_UPLOAD_MIME,
  MAX_UPLOAD_BYTES,
  formatBytes,
  uploadRejection,
} from '../attachmentRules';

describe('MAX_UPLOAD_BYTES', () => {
  it('is the server’s 25 MB per-file cap', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('uploadRejection', () => {
  it('allows the server mime allowlist', () => {
    for (const type of ALLOWED_UPLOAD_MIME) {
      expect(uploadRejection({ name: 'file', type, size: 10 })).toBeNull();
    }
  });

  it('rejects a blocked mime with a readable message', () => {
    expect(uploadRejection({ name: 'evil.svg', type: 'image/svg+xml', size: 10 })).toBe(
      'File type not allowed.',
    );
    expect(uploadRejection({ name: 'app.exe', type: 'application/octet-stream', size: 10 })).toBe(
      'File type not allowed.',
    );
  });

  it('falls back to the extension when the picker reports no mime', () => {
    for (const ext of ALLOWED_UPLOAD_EXT) {
      expect(uploadRejection({ name: `report${ext}`, type: '', size: 10 })).toBeNull();
    }
    expect(uploadRejection({ name: 'report.exe', type: '', size: 10 })).toBe(
      'File type not allowed.',
    );
    expect(uploadRejection({ name: 'nameless', type: '', size: 10 })).toBe('File type not allowed.');
  });

  it('rejects oversize files with the cap in the message', () => {
    expect(uploadRejection({ name: 'big.png', type: 'image/png', size: MAX_UPLOAD_BYTES })).toBeNull();
    expect(
      uploadRejection({ name: 'big.png', type: 'image/png', size: MAX_UPLOAD_BYTES + 1 }),
    ).toBe('File is too large — 25.0 MB max.');
  });

  it('skips the size gate when the picker withheld the size', () => {
    expect(uploadRejection({ name: 'big.png', type: 'image/png', size: null })).toBeNull();
  });
});

describe('formatBytes', () => {
  it('renders bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25.0 MB');
  });
});
