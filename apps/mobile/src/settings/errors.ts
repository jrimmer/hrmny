/**
 * @cytale/mobile — settings fetch error mapping (plan 004 M10, R15).
 *
 * The sections' fetches fail in two shapes the states-first contract tells
 * apart: a hard permission denial (403 / `forbidden`) renders the shell's
 * PermissionDenied, everything else renders ErrorState with the server's
 * message and a retry. Keeping the mapping here means both sections answer
 * the same way.
 */
import { ApiError } from '@cytale/api-client';

/** The server's message when it carried one, the caller's fallback otherwise. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}

/** True for a 403 / `forbidden` envelope — the surface may not read this. */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.key === 'forbidden');
}
