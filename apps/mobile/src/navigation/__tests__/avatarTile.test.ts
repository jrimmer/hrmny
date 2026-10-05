/**
 * The avatar tile palette (2026-09-28): white initials clear WCAG AA (4.5:1)
 * on every hue, and the colours match the web's `avatarTileColor`
 * (apps/web/src/app/ui/avatar.ts) — a member reads as the same colour on
 * both clients.
 */
import { avatarTileColor, contrastWithWhite } from '../ui';

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe('avatarTileColor', () => {
  it('clears 4.5:1 against white for all 360 hues', () => {
    const failing: string[] = [];
    for (let hue = 0; hue < 360; hue += 1) {
      const color = avatarTileColor(hue);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
      const ratio = contrastWithWhite(rgbOf(color));
      if (ratio < 4.5) failing.push(`${hue}: ${color} ${ratio.toFixed(2)}:1`);
    }
    expect(failing).toEqual([]);
  });

  it('matches the web palette at pinned hues', () => {
    // Pinned from the web helper: blue unchanged at hsl(240 45% 42%); the
    // yellow darkened to its AA lightness.
    expect(avatarTileColor(240)).toBe('#3b3b9b');
    expect(avatarTileColor(0)).toBe('#9b3b3b');
  });
});
