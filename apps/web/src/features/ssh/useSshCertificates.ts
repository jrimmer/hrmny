/**
 * @cytale/web — the SSH section's list machine (U3).
 *
 * Same shape as the integrations panes' `usePaneList`: a reload nonce, a
 * cancelled-flag fetch, `LoadState` transitions, and the 403 `ApiError` →
 * permission-denied mapping. It is written here rather than imported because
 * its integrations sibling maps its own feature's denial copy and lives one
 * directory away with a type import tied to *its* pane states; sharing it
 * would couple `features/ssh` to `features/integrations` internals, and
 * relocating it is outside this unit's file ownership. The machine's SHAPE is
 * shared via `app/ui/PaneStates.ts`; only the fetching is local.
 *
 * THE UNIT OF THE LIST IS A STORED KEY, NOT A CERTIFICATE. A member manages
 * keys — that is what they hold a private half for, what re-issue addresses,
 * and what removal retires (R5a, R6). A certificate is something a key has
 * accumulated, so each row carries its own certificates and the fingerprint
 * that lets the member match it to the file on their own machine.
 *
 * The mutations (issue, re-issue, remove) deliberately do NOT swallow their
 * failures: each throws to the caller, because the copy that makes a failure
 * actionable — "that public key was refused, here is why" — belongs to the
 * surface that knows which action the member just took.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@cytale/api-client';

import type { LoadState } from '../../app/ui/PaneStates.js';

import {
  sshCertificates,
  type SshCertificatesClient,
  type SshIssuedCertificate,
  type SshKey,
} from './certificates.js';

export interface SshCertificatesController {
  /** The member's stored keys, each with its certificates. */
  keys: SshKey[];
  loadState: LoadState;
  /** The 403 `ApiError` when the read was denied; null otherwise. */
  permissionDenied: ApiError | null;
  /** Refetch the list (the Retry button, post-mutation refresh). */
  reload(): void;
  /** Force the pane's error state (a mutation failure with no better home). */
  setError(message: string): void;
  /** R2: submit a public key, receive a signed certificate. */
  issue(publicKey: string): Promise<SshIssuedCertificate>;
  /** R6: a new certificate for a key already on file, without re-pasting it. */
  reissue(keyId: string): Promise<SshIssuedCertificate>;
  /** R5a: retire the stored public key. */
  remove(keyId: string): Promise<void>;
}

const LIST_ERROR_FALLBACK = 'Could not load your SSH certificates.';

export function useSshCertificates(
  client: SshCertificatesClient = sshCertificates,
): SshCertificatesController {
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [permissionDenied, setPermissionDenied] = useState<ApiError | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);
  const setError = useCallback((message: string) => setLoadState({ kind: 'error', message }), []);

  useEffect(() => {
    let cancelled = false;
    setLoadState({ kind: 'loading' });
    setPermissionDenied(null);

    client
      .list()
      .then((rows) => {
        if (cancelled) return;
        setKeys(rows);
        setLoadState({ kind: 'ready' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 403) {
          setPermissionDenied(error);
          setKeys([]);
          setLoadState({ kind: 'ready' });
          return;
        }
        setLoadState({
          kind: 'error',
          message: error instanceof Error ? error.message : LIST_ERROR_FALLBACK,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce]);

  const issue = useCallback(
    async (publicKey: string) => {
      const issued = await client.issue(publicKey);
      setReloadNonce((n) => n + 1);
      return issued;
    },
    [client],
  );

  const reissue = useCallback(
    async (keyId: string) => {
      const issued = await client.reissue(keyId);
      setReloadNonce((n) => n + 1);
      return issued;
    },
    [client],
  );

  const remove = useCallback(
    async (keyId: string) => {
      await client.remove(keyId);
      // Drop the key before the refetch so its affordances go away with the
      // action, not one round trip later. The server removes it for real —
      // this is only so the pane does not offer a button that now 404s.
      setKeys((previous) => previous.filter((key) => key.id !== keyId));
      setReloadNonce((n) => n + 1);
    },
    [client],
  );

  return { keys, loadState, permissionDenied, reload, setError, issue, reissue, remove };
}
