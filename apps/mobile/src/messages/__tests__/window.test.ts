/**
 * Message-window derivation tests (plan 004 M6, R8).
 *
 * The three pure rules behind the list: chat order, where the unread divider
 * sits (web's `MessageList` capture rule, reproduced), and when the divider
 * is scrolled past. Kept out of the component so they are asserted directly
 * rather than through a native list.
 */
import { chatOrder, dividerRetired, firstUnreadMessageId, indexOfMessage } from '../window';
import { IDS, makeMessage, messageId } from './support';

const messages = (...ns: number[]) => ns.map((n) => makeMessage(n));

describe('chatOrder', () => {
  it('flips the store’s newest-first slice into chat order', () => {
    expect(chatOrder(messages(3, 2, 1)).map((m) => m.id)).toEqual([
      messageId(1),
      messageId(2),
      messageId(3),
    ]);
  });

  it('is empty for an empty window and does not mutate the input', () => {
    expect(chatOrder([])).toEqual([]);
    const input = messages(2, 1);
    const out = chatOrder(input);
    expect(input.map((m) => m.id)).toEqual([messageId(2), messageId(1)]);
    expect(out).not.toBe(input);
  });
});

describe('firstUnreadMessageId', () => {
  const ordered = chatOrder(messages(5, 4, 3, 2, 1)); // chat order 1..5

  it('returns null without an unread slice or with a zero badge', () => {
    expect(firstUnreadMessageId({ ordered, unread: undefined, currentUserId: IDS.me })).toBeNull();
    expect(
      firstUnreadMessageId({
        ordered,
        unread: { last_read_id: messageId(3), unread_count: 0 },
        currentUserId: IDS.me,
      }),
    ).toBeNull();
  });

  it('points at the first row newer than the watermark', () => {
    expect(
      firstUnreadMessageId({
        ordered,
        unread: { last_read_id: messageId(3), unread_count: 2 },
        currentUserId: IDS.me,
      }),
    ).toBe(messageId(4));
  });

  it('treats a null watermark as “everything is new”', () => {
    expect(
      firstUnreadMessageId({
        ordered,
        unread: { last_read_id: null, unread_count: 5 },
        currentUserId: IDS.me,
      }),
    ).toBe(messageId(1));
  });

  it('skips my own rows and optimistic placeholders', () => {
    const mixed = chatOrder([
      makeMessage(4, { id: 'pending_abc', author_id: IDS.alice }),
      makeMessage(3, { author_id: IDS.me }),
      makeMessage(2, { author_id: IDS.alice }),
      makeMessage(1, { author_id: IDS.bob }),
    ]);
    expect(
      firstUnreadMessageId({
        ordered: mixed,
        unread: { last_read_id: messageId(1), unread_count: 3 },
        currentUserId: IDS.me,
      }),
    ).toBe(messageId(2));
  });

  it('returns null when nothing in the window is newer than the watermark', () => {
    expect(
      firstUnreadMessageId({
        ordered,
        unread: { last_read_id: messageId(5), unread_count: 1 },
        currentUserId: IDS.me,
      }),
    ).toBeNull();
  });
});

describe('dividerRetired', () => {
  it('never retires before the divider has been on screen', () => {
    // The list opens at the newest row, so the divider starts above the
    // viewport — an ungated rule would retire it immediately.
    expect(dividerRetired(1, 4, false)).toBe(false);
  });

  it('retires once the divider has been seen and the viewport moved past it', () => {
    expect(dividerRetired(1, 4, true)).toBe(true);
  });

  it('stays while the divider is still viewable or below the viewport', () => {
    expect(dividerRetired(4, 4, true)).toBe(false);
    expect(dividerRetired(4, 2, true)).toBe(false);
  });

  it('stays when either index is unknown', () => {
    expect(dividerRetired(null, 4, true)).toBe(false);
    expect(dividerRetired(1, null, true)).toBe(false);
  });
});

describe('indexOfMessage', () => {
  it('finds a message in chat order and reports -1 for a miss', () => {
    const ordered = chatOrder(messages(3, 2, 1));
    expect(indexOfMessage(ordered, messageId(2))).toBe(1);
    expect(indexOfMessage(ordered, messageId(9))).toBe(-1);
    expect(indexOfMessage(ordered, null)).toBe(-1);
  });
});
