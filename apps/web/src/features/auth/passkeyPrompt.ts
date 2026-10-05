/**
 * #36 follow-up (owner direction 2026-09-15): the owner was never ASKED to
 * set a passkey, which they consider part of passkeys being on. This module
 * is the tiny state seam behind that ask:
 *
 *   * `markPasswordLoginForPasskeyPrompt` — LoginPage sets it when a PASSWORD
 *     login (only) succeeds; passkey and SSO logins never do;
 *   * `consumePasswordLoginForPasskeyPrompt` — the shell's prompt consumes it
 *     at most once per login (module-scoped: it survives the LoginPage →
 *     AuthenticatedApp swap inside one document, dies on reload, and a
 *     reload-restored session correctly never prompts);
 *   * the dismissal is `localStorage` per browser — "Not now" means never
 *     nagged again on this browser (the NotificationPrompt posture), not
 *     merely for this session.
 */

/** Where a dismissal is remembered. Per browser, like every client-local pref. */
export const PASSKEY_PROMPT_DISMISSED_KEY = 'cytale.passkey-prompt-dismissed';

/** Set by a successful password login, consumed once by the shell's prompt. */
let pendingPasswordLogin = false;

export function markPasswordLoginForPasskeyPrompt(): void {
  pendingPasswordLogin = true;
}

/** True only for the login that just completed; reading it clears it. */
export function consumePasswordLoginForPasskeyPrompt(): boolean {
  const pending = pendingPasswordLogin;
  pendingPasswordLogin = false;
  return pending;
}

function wasDismissed(): boolean {
  try {
    return localStorage.getItem(PASSKEY_PROMPT_DISMISSED_KEY) === '1';
  } catch {
    // Storage unavailable: treat as dismissed rather than re-asking on every
    // render. Erring toward silence is the right direction for an invitation.
    return true;
  }
}

export function rememberDismissal(): void {
  try {
    localStorage.setItem(PASSKEY_PROMPT_DISMISSED_KEY, '1');
  } catch {
    // Storage unavailable — it will reappear next session, which is a lesser
    // problem than failing to record the member's answer.
  }
}

/** Test/inspection seam: whether this browser has recorded a "Not now". */
export function isPasskeyPromptDismissed(): boolean {
  return wasDismissed();
}
