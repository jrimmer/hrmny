/**
 * QrSvg — a dependency-thin QR renderer for the #127 TOTP enrollment.
 *
 * The SERVER never renders the QR (the otpauth URI rides the wire as a
 * string); both surfaces that show one — the login enrollment walk and the
 * Account section's Two-factor block — draw it HERE, client-side, from the
 * `toqr` encoder (a tiny zero-dependency QR matrix encoder, MIT — already in
 * the pnpm store, so no new network supply chain).
 *
 * Rendering is deliberately plain: one white quiet zone, one black module
 * path, crisp edges. QR scanners want the high-contrast black-on-white pair,
 * so the colors do not follow the theme — that is the spec-friendly
 * rendering, not a styling choice.
 */

import { useMemo } from 'react';

import { toQR } from 'toqr';

const QUIET_ZONE = 2;

export function QrSvg({
  value,
  size = 176,
  label,
  testId = 'qr-svg',
}: {
  /** The payload to encode (the otpauth URI for #127). */
  value: string;
  /** Rendered box size in px — the SVG scales, the matrix does not. */
  size?: number;
  /** Accessible description of what the code is FOR. */
  label: string;
  testId?: string;
}) {
  const matrix = useMemo(() => toQR(value), [value]);
  const dimension = Math.round(Math.sqrt(matrix.length));

  const path = useMemo(() => {
    const rects: string[] = [];
    for (let y = 0; y < dimension; y++) {
      for (let x = 0; x < dimension; x++) {
        if (matrix[y * dimension + x]) rects.push(`M${x} ${y}h1v1h-1z`);
      }
    }
    return rects.join('');
  }, [matrix, dimension]);

  return (
    <svg
      data-testid={testId}
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${dimension + QUIET_ZONE * 2} ${dimension + QUIET_ZONE * 2}`}
      shapeRendering="crispEdges"
    >
      <rect
        x={-QUIET_ZONE}
        y={-QUIET_ZONE}
        width={dimension + QUIET_ZONE * 2}
        height={dimension + QUIET_ZONE * 2}
        fill="#ffffff"
      />
      <path d={path} fill="#000000" />
    </svg>
  );
}
