/**
 * Cytale web — application boot (the SPA entry).
 *
 * Assembles the shipped surfaces into a running app:
 *   unauthenticated → LoginPage / RegisterPage / VerifyEmail / Forgot / Reset
 *   authenticated    → AppShell (rail + sidebar + MessagePane + members)
 *                      with the hash router from U19 and the auth session
 *                      from U19 session.ts (gateway connect on READY).
 *
 * Routing is the minimal hash router (react-router deliberately not added).
 * Live data flows in via the U17 default store: the gateway session applies
 * READY/dispatch events there, and every surface projection reads from it.
 */
import { StrictMode, lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './tokens-entry.js';
import { dismissBootCover, extendBootFailsafe } from './app/boot/splash.js';
import { registerServiceWorker } from './app/pwa/index.js';
import { UpdateAvailable } from './app/pwa/UpdateAvailable.js';
import { initDeviceCache } from './app/persist/bootCache.js';
import { defaultStore } from '@cytale/state';

import { useAuth, session } from './features/auth/index.js';
import { webTokenStorage } from './features/auth/authStore.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { RegisterPage } from './features/auth/RegisterPage.js';
import { VerifyEmailPage } from './features/auth/VerifyEmailPage.js';
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage.js';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage.js';
import { OidcCallbackPage } from './features/auth/OidcCallbackPage.js';
import { normalizeOidcProviderRedirect } from './features/auth/oidc.js';
import { useHashRoute } from './features/auth/router.js';
import { InviteLandingPage } from './features/channels/index.js';
import { isTauri, subscribeToDeepLinks } from './tauri/index.js';
import { wireExternalLinksToDefaultBrowser } from './tauri/externalLinks.js';
import { buildPermalinkPath } from '@cytale/domain';
// #88: the three web capture points (uncaught exceptions, unhandled
// rejections, the app-shell error boundary) plus the gateway telemetry poller.
// Installed at boot, BEFORE the first render, so an error thrown while the app
// is mounting is already reportable. The api-client's own failure observation
// is wired in features/auth/session.ts (the composition root).
import {
  AppErrorBoundary,
  installClientErrorCapture,
} from './features/observability/index.js';

// #21 bundle split: the authenticated shell (Lexical composer, virtuoso,
// Radix, every feature surface) loads behind this boundary — the login path
// ships only the entry + auth pages.
const loadShell = () => import('./AuthenticatedApp.js');
const AuthenticatedApp = lazy(loadShell);

// Lane D #4: the entry now runs, so it OWNS the boot cover — push the blind
// 4 s fail-safe out (it would otherwise reveal an empty frame mid-restore on
// a slow link). A hang is still bounded, by the app's own longer deadline.
extendBootFailsafe();

/**
 * Lane D #4: the boot's round trips used to run in series — restore (refresh,
 * then `/users/@me`), THEN import the shell chunk, THEN connect the gateway.
 * Each now starts as early as it can:
 *
 *   * a stored session (a refresh token on this device — the desktop shell's
 *     OS store is async, so there it is assumed) starts the shell chunk's
 *     download at ENTRY, alongside the restore, instead of after it;
 *   * the restore itself starts at entry rather than in the first render's
 *     effect (the session then opens the gateway right after the refresh,
 *     and the account rides the refresh response).
 */
function hasStoredSession(): boolean {
  try {
    return (webTokenStorage.read()?.refreshToken ?? null) !== null;
  } catch {
    return false;
  }
}
if (isTauri() || hasStoredSession()) void loadShell().catch(() => undefined);

const restoreSettled: Promise<void> = session.restore().catch(() => undefined);

// Lane D #8: the member's device snapshot loads alongside the restore and
// paints the shell with real data before READY lands (see bootCache.ts).
initDeviceCache({
  authStore: session.authStore,
  store: defaultStore,
  origin: globalThis.location?.origin ?? '',
});

/**
 * Reveals the application: mounted by every terminal branch (an auth page, the
 * authenticated shell), so the boot cover in `index.html` comes down exactly
 * when there is a surface behind it — never on a timer, never on the bundle
 * merely having loaded. Renders nothing; the cover it dismisses is not a React
 * node, and the boundary's fallback below keeps it up until the shell chunk
 * arrives.
 */
function BootReady() {
  useEffect(() => {
    dismissBootCover();
  }, []);
  return null;
}

function App() {
  const { state } = useAuth();
  const { path, query, navigate } = useHashRoute();

  // The restore started at entry (lane D #4); the auth pages wait for it to
  // settle so a stored session never flashes the login form.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let alive = true;
    void restoreSettled.finally(() => {
      if (alive) setRestored(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The shell is a lazy chunk (#21). Fetch it as soon as the session says
  // "authenticated" (a no-op when the entry already started it), and warm it
  // while the login form is up — the member is about to need it.
  useEffect(() => {
    if (state.status === 'authenticated') {
      void loadShell().catch(() => undefined);
      return;
    }
    if (state.status !== 'unauthenticated') return;
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const warm = () => void loadShell().catch(() => undefined);
    if (typeof idle === 'function') idle(warm);
    else setTimeout(warm, 1_500);
  }, [state.status]);

  // Boot: the cover stays up while the session restores. Same wait the old
  // bare `shell`/`pane` skeleton expressed — but that skeleton painted a
  // half-built app, and this paints nothing at all. `index.html` also arms a
  // 4s fail-safe, so a bundle that never executes cannot leave it stranded.
  if (!restored || state.status === 'loading') {
    return <UpdateAvailable />;
  }

  // Unauthenticated: auth pages per hash route. An `#/invite/{code}` route
  // renders the invite landing (flow F1); the code parks in sessionStorage
  // so the post-auth app resumes the join when the user signs back in.
  if (state.status !== 'authenticated') {
    const inviteMatch = /^\/invite\/([^/?#]+)/.exec(path);
    if (inviteMatch) {
      const code = decodeURIComponent(inviteMatch[1]!);
      return (
        <>
          <BootReady />
          <InviteLandingPage
            code={code}
            onNavigate={(to) => {
              try {
                sessionStorage.setItem('cytale.pending-invite', code);
              } catch {
                // storage unavailable — the join intent just isn't resumed
              }
              navigate(to);
            }}
          />
        </>
      );
    }
    const authPage = (() => {
      switch (path) {
        case '/register':
          return <RegisterPage onNavigate={navigate} />;
        case '/verify-email':
          return <VerifyEmailPage token={query.get('token')} onNavigate={navigate} />;
        case '/forgot-password':
          return <ForgotPasswordPage onNavigate={navigate} />;
        case '/reset-password':
          return <ResetPasswordPage token={query.get('token')} onNavigate={navigate} />;
        // #12: the OIDC provider's redirect lands here (a PATH redirect_uri —
        // fragments are illegal in OAuth; the SPA fallback served the app at
        // the path and the boot normalizer below moved the query into this
        // hash). It finishes the ceremony and continues to return_to.
        case '/auth/oidc/callback':
          return <OidcCallbackPage onNavigate={navigate} />;
        default:
          return <LoginPage onNavigate={navigate} />;
      }
    })();
    return (
      <>
        <BootReady />
        <UpdateAvailable />
        {authPage}
      </>
    );
  }

  return (
    // The fallback stays empty on purpose: the cover is still up while the
    // shell chunk lands, so a null fallback hands the wait to the cover
    // instead of painting a second skeleton behind it. The SHELL takes the
    // cover down itself (lane D #3): not on its first frame, but once it has
    // the member's roster to paint (or its own bound passes) — its first
    // frame used to be an empty Home.
    <>
      <UpdateAvailable />
      <Suspense fallback={null}>
        <AuthenticatedApp />
      </Suspense>
    </>
  );
}

// E2E driver — `__CYTALE_E2E__` is a define (vite.config.ts), so it lands here
// as a literal and Rollup drops this branch, the dynamic import, and the
// driver chunk itself from real builds.
if (__CYTALE_E2E__) {
  void import('./e2e/driver.js');
}

/**
 * #114 — the desktop shell's `cytale://` links, translated into the HASH.
 *
 * Installed at BOOT rather than inside the authenticated shell, because the
 * hash is the durable carrier of a target and the app renders a different tree
 * when signed out: writing `#/workspace/…/message/…` here means the link is
 * already in the URL by the time the login page renders, and the authenticated
 * shell (which parses the same hash on mount) continues to the message after
 * sign-in with nothing to remember and nothing to resume. It also covers the
 * cold start: the shell hands over the URL it was launched with, which by
 * definition arrives before any of this app exists.
 *
 * A no-op in a browser and in tests (the bridge resolves to null). Only a
 * MESSAGE address is translated: that is the one hash route this app
 * implements, and writing a hash nothing acts on would leave a stray address
 * in the URL.
 */
// Desktop shell: http(s) links in messages/cards open in the DEFAULT browser
// (the webview has no target=_blank handling of its own — owner report
// 2026-09-20). No-op in a browser.
wireExternalLinksToDefaultBrowser();

void subscribeToDeepLinks((target) => {
  if (target.kind !== 'message') return;
  const path = buildPermalinkPath(target);
  if (path !== null) globalThis.location.hash = path;
});

// #12 — the OIDC provider's redirect arrives as a PATH
// (`/auth/oidc/callback?code=…&state=…`, fragments being illegal in OAuth).
// Before the first render, rewrite it into the hash router's shape and clear
// the address (history-level replace), so the callback page mounts from the
// hash and a reload can never replay the single-use code. No-op on every
// other path.
normalizeOidcProviderRedirect();

// PWA: register the service worker (prompt mode, lane D #6 — an update waits
// for the member's consent; registration itself waits for `load`). Safe no-op
// where SWs are unavailable (file://, private mode).
registerServiceWorker();

// #88: install the capture points before the first render. `session.api`
// carries the reports; `session.getGateway()` reads the socket story the
// gateway client already tracks (it is null until a session connects, and the
// poller simply reports nothing until then).
installClientErrorCapture({
  api: session.api,
  gateway: () => session.getGateway(),
});

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>,
  );
}
