/**
 * @cytale/web — message hover toolbar placement config (2026-09-12).
 *
 * The placement is config-driven: the default lives in the module, and a
 * per-browser localStorage override flips the two without a rebuild. The
 * default is the top-right pill — the vertical rail was tried and set aside
 * (it reads as unattached on a one-line message), but both stay selectable.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  MESSAGE_ACTIONS_PLACEMENT_KEY,
  messageActionsPlacement,
  readStoredPlacement,
  setMessageActionsPlacement,
} from '../messageActionsPlacement.js';

afterEach(() => {
  // Back to the shipped default for the next case in this file.
  setMessageActionsPlacement('top-right');
});

describe('messageActionsPlacement', () => {
  it('defaults to the top-right pill', () => {
    expect(messageActionsPlacement()).toBe('top-right');
  });

  it('setMessageActionsPlacement switches the placement and persists it', () => {
    setMessageActionsPlacement('left-rail');
    expect(messageActionsPlacement()).toBe('left-rail');
    expect(globalThis.localStorage?.getItem(MESSAGE_ACTIONS_PLACEMENT_KEY)).toBe('left-rail');

    setMessageActionsPlacement('top-right');
    expect(messageActionsPlacement()).toBe('top-right');
  });

  it('reads a stored override', () => {
    globalThis.localStorage?.setItem(MESSAGE_ACTIONS_PLACEMENT_KEY, 'left-rail');
    expect(readStoredPlacement()).toBe('left-rail');
    globalThis.localStorage?.removeItem(MESSAGE_ACTIONS_PLACEMENT_KEY);
    expect(readStoredPlacement()).toBeNull();
  });

  it('ignores a garbage stored value', () => {
    globalThis.localStorage?.setItem(MESSAGE_ACTIONS_PLACEMENT_KEY, 'sideways');
    expect(readStoredPlacement()).toBeNull();
    globalThis.localStorage?.removeItem(MESSAGE_ACTIONS_PLACEMENT_KEY);
  });
});
