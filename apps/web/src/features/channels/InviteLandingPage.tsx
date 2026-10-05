/**
 * @cytale/web — InviteLandingPage (U20, origin flow F1).
 *
 * The unauthenticated invite-link landing route (`/invite/{code}`). Shows
 * the workspace name before redirecting through login-or-register; after
 * auth, redemption against U9's invite resolve endpoint joins the workspace
 * and navigation lands in its default channel.
 *
 * States-first DoD: loading / ready / expired / revoked / invalid each get a
 * distinct empty-state. The page is deliberately presentational — it calls
 * `onNavigate` for login/register and `onAccept` for the post-auth join so
 * the app shell owns routing and the auth/session seam.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { resolveInvite, type ResolvedInvite } from './api.js';

export interface InviteLandingPageProps {
  /** The invite code from the URL (`/invite/{code}`). */
  code: string;
  /** True when the user is already authenticated (post-auth redemption). */
  authenticated?: boolean;
  /** Called to navigate to login/register (pre-auth). */
  onNavigate?: (to: string) => void;
  /** Called to accept the invite (post-auth join). */
  onAccept?: (code: string) => Promise<void>;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; invite: ResolvedInvite }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

export function InviteLandingPage({
  code,
  authenticated = false,
  onNavigate,
  onAccept,
}: InviteLandingPageProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });

    resolveInvite(code)
      .then((invite) => {
        if (cancelled) return;
        if (invite.workspace === null) {
          setState({ kind: 'invalid' });
          return;
        }
        setState({ kind: 'ready', invite });
      })
      .catch((err: { status?: number; key?: string; message?: string }) => {
        if (cancelled) return;
        // Distinct empty-states per the plan: expired vs revoked vs invalid.
        if (err.key === 'invite_not_found') {
          setState({ kind: 'invalid' });
        } else if (err.status === 410) {
          setState({ kind: 'expired' });
        } else {
          setState({ kind: 'error', message: err.message ?? 'Could not load this invite.' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  async function handleAccept() {
    setJoining(true);
    try {
      await onAccept?.(code);
    } finally {
      setJoining(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center bg-background px-4">
        <div
          role="progressbar"
          aria-busy="true"
          data-testid="invite-loading"
          className="rounded-lg border border-line bg-surface p-8 text-sm text-text-muted"
        >
          Loading invite…
        </div>
      </div>
    );
  }

  if (state.kind === 'invalid') {
    return (
      <InviteStateAlert testId="invite-invalid" title="This invite is invalid">
        The invite link you followed is not valid. Ask the workspace owner for a new one.
      </InviteStateAlert>
    );
  }

  if (state.kind === 'expired') {
    return (
      <InviteStateAlert testId="invite-expired" title="This invite has expired">
        The invite link you followed has expired. Ask the workspace owner for a new one.
      </InviteStateAlert>
    );
  }

  if (state.kind === 'revoked') {
    return (
      <InviteStateAlert testId="invite-revoked" title="This invite was revoked">
        The invite link you followed was revoked. Ask the workspace owner for a new one.
      </InviteStateAlert>
    );
  }

  if (state.kind === 'error') {
    return (
      <InviteStateAlert testId="invite-error" title="Could not load this invite">
        {state.message}
      </InviteStateAlert>
    );
  }

  const { invite } = state;
  const workspaceName = invite.workspace?.name ?? 'this workspace';

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4" data-testid="invite-ready">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-8">
        <h1 className="mb-4 text-xl font-semibold text-text-primary">Join {workspaceName}</h1>
        <p className="mb-6 text-sm text-text-muted">
          You've been invited to join {workspaceName} on Hrmny.
        </p>

        {authenticated ? (
          <button
            type="button"
            onClick={handleAccept}
            disabled={joining}
            className="w-full rounded-md bg-accent px-3 py-2 font-medium text-text-onaccent transition-[filter,opacity] duration-[var(--duration-control)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {joining ? 'Joining…' : 'Accept invite'}
          </button>
        ) : (
          <div className="invite-auth-actions">
            <button
              type="button"
              onClick={() => onNavigate?.('/login')}
              className="w-full rounded-md bg-accent px-3 py-2 font-medium text-text-onaccent transition-[filter,opacity] duration-[var(--duration-control)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => onNavigate?.('/register')}
              className="w-full rounded-md border border-line bg-transparent px-3 py-2 font-medium text-text transition-colors duration-[var(--duration-control)] hover:border-input-line hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              Create an account
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Shared invite empty/error state: centered card, heading + muted copy. */
function InviteStateAlert({
  testId,
  title,
  children,
}: {
  testId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <div
        role="alert"
        data-testid={testId}
        className="w-full max-w-sm rounded-lg border border-danger/30 bg-surface p-8"
      >
        <h1 className="mb-2 text-xl font-semibold text-danger">{title}</h1>
        <p className="text-sm text-text-muted">{children}</p>
      </div>
    </div>
  );
}
