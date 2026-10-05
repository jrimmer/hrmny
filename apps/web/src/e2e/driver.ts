/**
 * @cytale/web — in-shell e2e driver (dev builds only).
 *
 * WHY THIS EXISTS: the desktop shell is a WKWebView, and macOS has no
 * WebDriver for WKWebView (tauri-driver is Windows/Linux only), so the app
 * cannot be driven from outside on a Mac. Instead an e2e BUILD drives
 * itself: when `VITE_CYTALE_E2E` is set, main.tsx dynamically imports this
 * module (Rollup drops it entirely otherwise) and the driver runs a scripted
 * user flow inside the real shell — the same DOM the browser specs exercise,
 * but over `tauri://localhost`, through the baked origin and the CORS
 * allowlist that only the packaged app uses.
 *
 * The runner (tools/desktop-e2e.mts) owns the inputs and collects reports
 * over a loopback control channel; it seeds the account/workspace/channel
 * through the API and asserts on the report.
 *
 * Flow: reset any persisted session → login (real UI) → select workspace →
 * select channel → type into the Lexical composer → Enter → assert the row.
 */

const CONTROL = 'http://127.0.0.1:4199';
const RESET_FLAG = 'cytale.e2e.reset';

import { parsePermalinkPath } from '@cytale/domain';

/**
 * Does the address name exactly this message? Judged with the app's own
 * grammar (#114): the hash carries ENCODED ids (`g91dMy2uEC`, not the raw
 * snowflake), so the driver must not string-match the id it seeded — it
 * parses the hash the same way the router does and compares the struct.
 */
function hashNamesMessage(hash: string, messageId: string): boolean {
  const target = parsePermalinkPath(hash.replace(/^#/, ''));
  return target?.kind === 'message' && target.messageId === messageId;
}

/** Recent app-originated fetches (control-channel traffic filtered out). */
const fetchLog: string[] = [];

function instrumentFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    try {
      const res = await original(input, init);
      if (!url.startsWith(CONTROL)) fetchLog.push(`${method} ${url} → ${res.status}`);
      return res;
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (!url.startsWith(CONTROL)) fetchLog.push(`${method} ${url} → THREW ${detail}`);
      throw err;
    }
  };
  // Images do not go through fetch: record their load failures too, or a
  // blocked/broken avatar or workspace icon is silent.
  window.addEventListener(
    'error',
    (event) => {
      const target = event.target as HTMLImageElement | null;
      if (target && target.tagName === 'IMG') {
        fetchLog.push(`IMG FAILED: ${target.currentSrc || target.src || '(no src)'}`);
      }
    },
    true,
  );
}

interface E2EConfig {
  username: string;
  password: string;
  wsId: string;
  chId: string;
  message: string;
  /** `deep-link` switches run() to the #50 acceptance flow (default: classic). */
  scenario?: 'classic' | 'deep-link';
  /** Present only in the deep-link scenario. */
  deepLink?: {
    /** The message the COLD-START link names (launch argument). */
    coldMessageId: string;
    coldMessage: string;
    /** The message the RUNNING-INSTANCE link names (delivered mid-run). */
    liveMessageId: string;
    liveMessage: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fire-and-forget report; the control channel may already be gone. */
async function report(tag: string, data: Record<string, unknown> = {}): Promise<void> {
  const qs = new URLSearchParams({ tag });
  for (const [key, value] of Object.entries(data)) qs.set(key, String(value));
  try {
    await fetch(`${CONTROL}/report?${qs.toString()}`, { mode: 'cors' });
  } catch {
    /* control channel down — the runner will time out with what it has */
  }
}

async function waitFor<T>(
  what: string,
  find: () => T | null | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(120);
  }
}

/** React controlled inputs ignore a plain `.value =` write; use the native setter. */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === text,
    ) ?? null
  );
}

async function login(cfg: E2EConfig): Promise<void> {
  const identifier = await waitFor('login identifier', () =>
    document.querySelector<HTMLInputElement>('#login-identifier'),
  );
  setNativeValue(identifier, cfg.username);
  const password = await waitFor('login password', () =>
    document.querySelector<HTMLInputElement>('#login-password'),
  );
  setNativeValue(password, cfg.password);
  (await waitFor('sign-in button', () => buttonByText('Sign in'))).click();
  await report('login-submitted');
  try {
    await waitFor('app shell', () => byTestId('app-shell'), 30_000);
  } catch (err) {
    // Smoke mode uses a deliberately invalid account: surface the server's
    // answer so a network/CORS failure is distinguishable from a 401.
    const alert = document.querySelector('[role="alert"]')?.textContent ?? '';
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} — login page said: ${alert || '(nothing)'}`,
    );
  }
  await report('shell-ready');
}

/** Report how the rail's workspace icons actually resolve inside the shell. */
async function checkRailIcons(): Promise<void> {
  await waitFor('workspace rail', () => byTestId('workspace-rail'), 15_000);
  await sleep(2_500); // let the images settle
  const items = Array.from(document.querySelectorAll('[data-testid^="workspace-"]'))
    .filter((row) => row.getAttribute('data-testid') !== 'workspace-rail')
    .map((row) => {
      // naturalWidth stays 0 for an image the webview refused, so this
      // distinguishes "no icon" from "icon blocked/failed" in a shell-only
      // failure, where the network panel is not available.
      const img = row.querySelector('img');
      return {
        id: row.getAttribute('data-testid'),
        label: row.getAttribute('aria-label'),
        src: img ? img.getAttribute('src') : null,
        complete: img ? img.complete : null,
        natural: img ? img.naturalWidth : null,
      };
    });
  await report('rail-icons', { detail: JSON.stringify(items).slice(0, 380) });
}

async function openChannel(cfg: E2EConfig): Promise<void> {
  (await waitFor('workspace rail item', () => byTestId(`workspace-${cfg.wsId}`))).click();
  (await waitFor('channel row', () => byTestId(`channel-${cfg.chId}`))).click();
  await waitFor('message composer', () => byTestId('message-compose'));
  await report('channel-open');
}

interface E2EBridge {
  text(): string;
  send(): void;
}

/** Composer bridge (E2EBridgePlugin) — present only in e2e builds. */
function bridge(): E2EBridge | undefined {
  return (window as unknown as { __cytaleE2E?: E2EBridge }).__cytaleE2E;
}

function rowVisible(message: string): boolean {
  return Array.from(document.querySelectorAll('[data-testid="message-item"]')).some((row) =>
    (row.textContent ?? '').includes(message),
  );
}

/** Type into the Lexical composer and send with Enter (Enter=send). */
async function sendMessage(cfg: E2EConfig): Promise<void> {
  const editable = await waitFor('composer editor', () =>
    byTestId('message-compose')?.querySelector<HTMLElement>('[contenteditable="true"]'),
  );

  // Lexical tracks the DOM selection; place a real caret first.
  editable.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);

  // execCommand fires the NATIVE beforeinput/input pair Lexical reconciles
  // from (its own guard uses event timestamps that synthetic events miss).
  document.execCommand('insertText', false, cfg.message);
  await sleep(300);
  await report('typed', {
    draft: editable.textContent ?? '',
    lexical: bridge()?.text() ?? '(no bridge)',
  });

  editable.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  await sleep(1_500);

  if (!rowVisible(cfg.message)) {
    // Synthetic Enter does not always reach Lexical's command in WKWebView.
    // Fall back to the composer's own send path (the same onSend the Enter
    // handler calls) so the shell integration is still exercised end-to-end.
    bridge()?.send();
    await sleep(1_500);
    await report('send-via-bridge', {
      lexical: bridge()?.text() ?? '',
      composerError: byTestId('composer-error')?.textContent ?? '',
      fetches: fetchLog.slice(-6).join(' | '),
    });
  }

  await waitFor('message row in the transcript', () => rowVisible(cfg.message) && true, 20_000);
}

/** The Members rail must render the directory — the packaged-shell fetch path. */
async function checkMembersDirectory(): Promise<void> {
  // Owner direction 2026-09-12 removed the rail TAB row: the members column
  // is now chosen from the window's rail icons, so the tab button may not
  // exist. Click it when it does (older builds); otherwise the directory is
  // already the rail's current content — just wait for it.
  const tab = byTestId('rail-tab-members');
  if (tab) tab.click();
  await waitFor('people directory', () => byTestId('people-directory'), 15_000);
  await sleep(1_500);
  const error = byTestId('people-error')?.textContent ?? '';
  const rows = document.querySelectorAll('[data-testid^="people-row-"]').length;
  await report('members-directory', { rows: String(rows), error });
  if (error) throw new Error(`people directory error state: ${error}`);
}

/**
 * Drop the shell's persisted session from the OS credential store.
 *
 * Clearing webview storage is no longer enough: since session tokens moved to
 * the keychain (tauriTokenStorage), a run that only cleared localStorage came
 * back already signed in from the PREVIOUS run — the login form never
 * appeared and the workspace ids belonged to the older seed. The harness must
 * reset the session where it now lives.
 */
async function clearKeychainSession(): Promise<boolean> {
  const internals = (window as { __TAURI_INTERNALS__?: { invoke?: (c: string) => Promise<unknown> } })
    .__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') return false; // browser build: nothing to clear
  try {
    await internals.invoke('secrets_delete');
    return true;
  } catch {
    return false; // a missing entry is fine; a hard failure is reported below
  }
}

async function run(): Promise<void> {
  // A previous run may have persisted a refresh token — in webview storage
  // AND in the OS credential store. Reset both, once (flagged), so the login
  // form is always the entry point; the reload re-enters this driver with the
  // flag set.
  try {
    if (!sessionStorage.getItem(RESET_FLAG)) {
      sessionStorage.setItem(RESET_FLAG, '1');
      localStorage.clear();
      const keychainCleared = await clearKeychainSession();
      await report('session-reset', { keychain: String(keychainCleared) });
      location.reload();
      return;
    }
  } catch {
    /* storage unavailable — proceed with whatever session exists */
  }

  instrumentFetch();
  await report('driver-start', { href: location.href });
  const cfg = (await (await fetch(`${CONTROL}/config`)).json()) as E2EConfig;

  if (cfg.scenario === 'deep-link' && cfg.deepLink) {
    await runDeepLink(cfg);
    return;
  }

  await login(cfg);
  await checkRailIcons();
  await openChannel(cfg);
  await sendMessage(cfg);
  await checkMembersDirectory();
  await report('pass', { message: cfg.message, fetches: fetchLog.slice(-10).join(' | ') });
}

/**
 * #50 acceptance — a `cytale://workspace/{w}/channel/{c}/message/{m}` link
 * lands on that message, for BOTH delivery paths, asserted from inside the
 * real shell:
 *
 * **Cold start** (cytale-deep-link via the shell's retained launch URL): the
 * OS launched the app WITH the link, so the URL was held in Rust and handed
 * to the web app at boot — before login, before any listener. The evidence
 * is the HASH being present while signed out: the driver waits for
 * `#/…/message/{coldMessageId}` to appear (the login page is the current
 * tree), reports it, THEN signs in — the authenticated shell continues to
 * the message from the hash with nothing to resume.
 *
 * **Running instance** (cytale-deep-link via the live event): the harness
 * delivers a second link while this process is up; LaunchServices hands it
 * to the running app, the shell re-emits it, and the boot-installed listener
 * rewrites the hash. The driver watches for the hash CHANGING to the second
 * message and for its row to render.
 */
async function runDeepLink(cfg: E2EConfig): Promise<void> {
  const dl = cfg.deepLink!;

  // Cold-start evidence: the launch URL, rewritten into the hash at boot.
  await waitFor('cold-start deep-link hash', () =>
    hashNamesMessage(location.hash, dl.coldMessageId) ? true : null,
  );
  await report('deeplink-cold-hash', { href: location.href });

  await login(cfg);

  // The signed-in shell consumed the hash: the channel opened and the
  // message the link named is on screen.
  await waitFor('cold-start message row', () =>
    rowVisible(dl.coldMessage) && hashNamesMessage(location.hash, dl.coldMessageId) ? true : null,
  );
  await report('deeplink-cold-landed', { href: location.href });

  // Running-instance delivery: the harness sends the second link only after
  // the cold landing is confirmed, so any hash change below happened on a
  // LIVE event against a fully-mounted app, not a pending boot handover.
  await waitFor('running-instance deep-link hash change', () =>
    hashNamesMessage(location.hash, dl.liveMessageId) ? true : null,
  );
  await waitFor('running-instance message row', () =>
    rowVisible(dl.liveMessage) && hashNamesMessage(location.hash, dl.liveMessageId) ? true : null,
  );
  await report('deeplink-live-landed', { href: location.href });

  await report('pass', {
    cold: dl.coldMessageId,
    live: dl.liveMessageId,
    href: location.href,
    fetches: fetchLog.slice(-6).join(' | '),
  });
}

void run().catch(async (err: unknown) => {
  await report('fail', {
    error: err instanceof Error ? err.message : String(err),
    href: location.href,
    fetches: fetchLog.slice(-8).join(' | '),
  });
});

export {};
