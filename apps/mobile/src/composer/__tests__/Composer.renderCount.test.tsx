/**
 * Composer render fan-out (performance pass, P3).
 *
 * The composer's input is a controlled field, so `ComposerView` re-renders on
 * every keystroke — that part is not negotiable. What must NOT ride along is
 * the furniture around it: the 133-cell emoji panel and the attachment chips
 * are memoized components with stable props, so a keystroke that changes only
 * the text must not re-render them.
 *
 * The counters live in test doubles for calls each child makes once per
 * render:
 *
 *   * the panel's grid resolves one shortcode per cell through
 *     `canonicalShortcode` (133 calls per grid render);
 *   * a staged chip formats its size through `formatBytes` (one call per chip
 *     per tray render).
 *
 * A memo bail-out means the child's body never runs, so the counter does not
 * move; a regression (an inline `onClose`/`onPick` closure, a non-memoized
 * child) shows up as a full grid's worth of extra calls.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { EMOJI_CATALOG } from '@cytale/emoji';

import { resetSurfaceStates } from '../../navigation/shellState';
import { PICKED, UPLOADED, renderComposer } from './support';

/** `jest.mock` factories are hoisted; `mock`-prefixed bindings are the escape. */
var mockShortcodeLookups = 0;
var mockByteFormats = 0;

jest.mock('@cytale/emoji', () => {
  const actual = jest.requireActual('@cytale/emoji');
  return {
    ...actual,
    canonicalShortcode: (emoji: string) => {
      mockShortcodeLookups += 1;
      return actual.canonicalShortcode(emoji);
    },
  };
});

jest.mock('../attachmentRules', () => {
  const actual = jest.requireActual('../attachmentRules');
  return {
    ...actual,
    formatBytes: (bytes: number) => {
      mockByteFormats += 1;
      return actual.formatBytes(bytes);
    },
  };
});

/** The composer's host TextInput instance (RNTL's element type). */
function input(): ReturnType<typeof screen.getByTestId> {
  return screen.getByTestId('composer-input');
}

async function typeInto(text: string): Promise<void> {
  await fireEvent.changeText(input(), text);
  await waitFor(() => expect(input().props.value).toBe(text));
}

beforeEach(() => {
  resetSurfaceStates();
  mockShortcodeLookups = 0;
  mockByteFormats = 0;
});

describe('composer memo boundaries', () => {
  it('keeps the emoji panel out of the keystroke path', async () => {
    await renderComposer({ send: jest.fn(), upload: jest.fn() });

    await fireEvent.press(screen.getByTestId('composer-emoji'));
    await waitFor(() => expect(screen.getByTestId('emoji-grid')).toBeTruthy());

    // One lookup per cell: the grid really is the whole catalog.
    const gridRenders = mockShortcodeLookups;
    expect(gridRenders).toBe(EMOJI_CATALOG.length);

    await typeInto('hello there');

    // The composer re-rendered (the input is controlled) but the memoized
    // panel did not: no further per-cell work at all.
    expect(mockShortcodeLookups).toBe(gridRenders);
  });

  it('keeps the attachment tray out of the keystroke path', async () => {
    await renderComposer({
      send: jest.fn(),
      pickImageLibrary: async () => [PICKED],
      upload: async () => UPLOADED,
    });

    await fireEvent.press(screen.getByTestId('composer-attach'));
    await fireEvent.press(screen.getByTestId('composer-attach-library'));
    await waitFor(() => expect(screen.getByTestId('attachment-chip')).toBeTruthy());
    // Let the injected upload settle so the snapshot below is stable.
    await waitFor(() => expect(screen.queryByTestId('attachment-upload-pending')).toBeNull());

    const trayRenders = mockByteFormats;
    expect(trayRenders).toBe(1);

    await typeInto('with an attachment');

    expect(mockByteFormats).toBe(trayRenders);
  });
});
