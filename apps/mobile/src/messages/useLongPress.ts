/**
 * @cytale/mobile — long-press detection for message rows (plan 004 M8, R11).
 *
 * RN's `Pressable` already cancels a long press when the list takes the
 * responder, but its cancellation path is Pressability internals — not
 * something a unit test can drive without poking the implementation. This
 * hook keeps the gesture explicit and mirrors web's `MessageItem` handlers
 * (timer + press origin + movement slop + cancel on scroll/termination):
 *
 *   * `onStartShouldSetResponder` claims the touch on the BUBBLE phase, so a
 *     nested pressable run (a link) still wins its own taps — the row only
 *     gets touches that did not land on an interactive child;
 *   * the timer starts on `onResponderGrant` and is cancelled by any of:
 *     movement past `slop` (`onResponderMove`), the list asking for the
 *     responder to scroll (`onResponderTerminationRequest` → true, then
 *     `onResponderTerminate`), or the finger lifting early
 *     (`onResponderRelease`). A drag therefore never opens the sheet;
 *   * unmount clears the timer — a recycled FlashList cell must not fire a
 *     stale long-press.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { GestureResponderEvent, ViewProps } from 'react-native';

/** Hold duration (web's `LONG_PRESS_MS`). */
export const LONG_PRESS_MS = 500;
/** Movement that turns a hold into a scroll/drag (web's `LONG_PRESS_SLOP_PX`). */
export const LONG_PRESS_SLOP = 12;

export interface LongPressOptions {
  /** Fired once per qualifying hold. */
  onLongPress: () => void;
  /** Hold duration in ms. */
  delay?: number;
  /** Movement tolerance in px before the hold is cancelled. */
  slop?: number;
  /** False detaches the gesture entirely (no responder claim). */
  enabled?: boolean;
}

/** The responder props a row spreads onto its container. */
export type LongPressHandlers = Pick<
  ViewProps,
  | 'onStartShouldSetResponder'
  | 'onResponderGrant'
  | 'onResponderMove'
  | 'onResponderRelease'
  | 'onResponderTerminate'
  | 'onResponderTerminationRequest'
>;

export function useLongPress({
  onLongPress,
  delay = LONG_PRESS_MS,
  slop = LONG_PRESS_SLOP,
  enabled = true,
}: LongPressOptions): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  /** Latest callback without re-arming the gesture props on every render. */
  const callback = useRef(onLongPress);
  useEffect(() => {
    callback.current = onLongPress;
  }, [onLongPress]);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  // Never leak the timer past unmount (FlashList recycles rows mid-hold).
  useEffect(() => cancel, [cancel]);

  const onStartShouldSetResponder = useCallback(() => enabled, [enabled]);

  const onResponderGrant = useCallback(
    (event: GestureResponderEvent) => {
      if (!enabled) return;
      cancel();
      const { pageX, pageY } = event.nativeEvent;
      origin.current = { x: pageX, y: pageY };
      timer.current = setTimeout(() => {
        timer.current = null;
        origin.current = null;
        callback.current();
      }, delay);
    },
    [cancel, delay, enabled],
  );

  const onResponderMove = useCallback(
    (event: GestureResponderEvent) => {
      const start = origin.current;
      if (timer.current === null || start === null) return;
      const dx = event.nativeEvent.pageX - start.x;
      const dy = event.nativeEvent.pageY - start.y;
      if (Math.sqrt(dx * dx + dy * dy) > slop) cancel();
    },
    [cancel, slop],
  );

  const onResponderRelease = useCallback(() => cancel(), [cancel]);
  const onResponderTerminate = useCallback(() => cancel(), [cancel]);
  /** Yes: the list may take the responder to scroll (cancels the hold). */
  const onResponderTerminationRequest = useCallback(() => true, []);

  return {
    onStartShouldSetResponder,
    onResponderGrant,
    onResponderMove,
    onResponderRelease,
    onResponderTerminate,
    onResponderTerminationRequest,
  };
}
