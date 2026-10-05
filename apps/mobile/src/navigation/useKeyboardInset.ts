/**
 * @cytale/mobile — the keyboard's frame height as an inset (iOS).
 *
 * KeyboardAvoidingView's `padding` behavior stopped keeping the composer
 * above the keyboard on iOS 27 devices (device feedback 2442), so the
 * channel surface and the thread body apply this inset directly instead.
 * Android is excluded: the manifest's adjustResize handles it there.
 */
import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const change = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      const height = event?.endCoordinates?.height ?? 0;
      setInset(height > 0 ? height : 0);
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => setInset(0));
    return () => {
      change.remove();
      hide.remove();
    };
  }, []);

  return inset;
}
