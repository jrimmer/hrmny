/**
 * @cytale/web — shared dialog error rendering (channels feature).
 *
 * Dialogs surface server denials honestly: a 403 `forbidden` envelope maps
 * to the surface's permission-denied copy (states-first DoD), anything else
 * carries the server's message through untouched.
 */

import { ApiError } from '@cytale/api-client';

export function dialogErrorMessage(
  err: unknown,
  forbiddenCopy: string,
  fallback: string,
): string {
  if (err instanceof ApiError) {
    if (err.key === 'forbidden') return forbiddenCopy;
    return err.message || fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
