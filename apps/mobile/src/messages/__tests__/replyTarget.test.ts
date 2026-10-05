/**
 * Reply-target tests (plan 004 M8, R11).
 *
 * The sheet builds this object and the composer consumes it; the contract is
 * pinned here so both units move together (the M7 worker wires `onReply` to
 * the channel route against exactly this shape).
 */
import { REPLY_PREVIEW_MAX, replyPreview, replyTargetFor } from '../replyTarget';
import { IDS, makeMessage, messageId } from './support';

describe('replyPreview', () => {
  it('collapses whitespace runs into one line', () => {
    expect(replyPreview('hello\n\n  world\tagain')).toBe('hello world again');
  });

  it('ellipsizes past the budget at exactly the budget length', () => {
    const long = 'x'.repeat(200);
    const preview = replyPreview(long);
    expect(preview).toHaveLength(REPLY_PREVIEW_MAX);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('tolerates missing content (attachment-only rows)', () => {
    expect(replyPreview(null)).toBe('');
    expect(replyPreview(undefined)).toBe('');
  });
});

describe('replyTargetFor', () => {
  it('carries the message id, author id, and the one-line preview', () => {
    const message = makeMessage(1, { author_id: IDS.alice, content: 'line one\nline two' });
    expect(replyTargetFor(message)).toEqual({
      messageId: messageId(1),
      authorId: IDS.alice,
      preview: 'line one line two',
      ping: true,
    });
  });

  it('defaults ping on and honours an explicit suppression', () => {
    const message = makeMessage(1);
    expect(replyTargetFor(message).ping).toBe(true);
    expect(replyTargetFor(message, { ping: false }).ping).toBe(false);
  });
});
