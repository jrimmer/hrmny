/**
 * @cytale/web — ServerSettingsPage (#121), the operator's Server Settings
 * surface (the Home gear's "Server settings" entry, `#/serversettings`).
 *
 * A textarea-class JSON editor over the server's one editable config file:
 *
 *   * prefilled from `GET /admin/config` (the document NEVER carries a
 *     secret — that is what makes the plain round-trip honest);
 *   * **Cancel** reverts to the served state (a fresh GET — the display is
 *     revalidated, not just rewound);
 *   * **Save** client-parses first (the cheap early JSON error), then PUTs;
 *     the server's validation error renders SPECIFICALLY (its message names
 *     the offending key and what was wrong);
 *   * a save that moved a BOOT-scoped key answers `restart_required` and the
 *     page prompts "Restart now?" → POST /admin/restart → poll `/health`
 *     until the node answers → reload. A runtime-only save says it applied
 *     live.
 *
 * The API + health/reload seams are props so the suite drives every state
 * hermetically.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ServerConfigDocument, ServerConfigSaveResult } from '@cytale/api-client';
import { paneCloseButtonClass } from '../../app/ui/button.js';

export interface ServerSettingsPageProps {
  load(): Promise<ServerConfigDocument>;
  save(config: Record<string, unknown>): Promise<ServerConfigSaveResult>;
  restart(): Promise<void>;
  onClose(): void;
  /** Defaults to polling `GET {origin}/health` until it answers. */
  pollHealth?: (signal: AbortSignal) => Promise<boolean>;
  /** Defaults to `location.reload()`. */
  reload?: () => void;
}

type Phase = 'loading' | 'ready' | 'load-error' | 'saving' | 'restarting';

const RESTART_POLL_MS = 1_000;
const RESTART_POLL_LIMIT = 120;

export function ServerSettingsPage({
  load,
  save,
  restart,
  onClose,
  pollHealth = defaultPollHealth,
  reload = defaultReload,
}: ServerSettingsPageProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [doc, setDoc] = useState<ServerConfigDocument | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const servedRef = useRef<ServerConfigDocument | null>(null);

  const fetchDoc = useCallback(async () => {
    const next = await load();
    servedRef.current = next;
    setDoc(next);
    setText(JSON.stringify(next.config, null, 2) + '\n');
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchDoc()
      .then(() => {
        if (!cancelled) setPhase('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load the server configuration.');
        setPhase('load-error');
      });
    return () => {
      cancelled = true;
    };
  }, [fetchDoc]);

  const handleCancel = useCallback(async () => {
    setError(null);
    setNotice(null);
    setRestartRequired(false);
    setPhase('loading');
    try {
      // Revert AND revalidate: the display is rebuilt from a fresh GET.
      await fetchDoc();
      setPhase('ready');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not reload the server configuration.');
      setPhase('load-error');
    }
  }, [fetchDoc]);

  const handleSave = useCallback(async () => {
    setError(null);
    setNotice(null);

    // The cheap early error: the client parses before the wire does.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      setError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    setPhase('saving');
    try {
      const result = await save(parsed as Record<string, unknown>);
      setRestartRequired(result.restart_required);
      setNotice(
        result.restart_required
          ? `Saved (${result.changed.join(', ')}). Restart to apply the boot-scoped change.`
          : `Saved (${result.changed.join(', ')}) — applied live, no restart needed.`,
      );
      setPhase('ready');
    } catch (err: unknown) {
      // The server's validation error is the SPECIFIC rendering: it names
      // the offending key and the violated rule (ApiError.message carries
      // the joined "path: reason" list).
      setError(err instanceof Error ? err.message : 'The server refused the save.');
      setPhase('ready');
    }
  }, [save, text]);

  const handleRestartNow = useCallback(async () => {
    setPhase('restarting');
    setError(null);
    try {
      await restart();
    } catch {
      // The stop races the response by design — a refused/lost answer still
      // means "wait for the node", which is exactly what the poll does.
    }
    // The node is going down; wait for it to come back, then start fresh.
    for (let attempt = 0; attempt < RESTART_POLL_LIMIT; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
      const controller = new AbortController();
      try {
        if (await pollHealth(controller.signal)) {
          reload();
          return;
        }
      } catch {
        // not up yet — keep polling
      } finally {
        controller.abort();
      }
    }
    setError('The server did not come back within the wait window — check the node, then reload manually.');
    setPhase('ready');
  }, [pollHealth, reload, restart]);

  return (
    <section aria-label="Server settings" data-testid="serversettings" className="flex h-full flex-col bg-background">
      <header className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <h1
          className="min-w-0 flex-1 truncate text-lg font-semibold text-text-primary"
          data-testid="serversettings-title"
        >
          Server settings
        </h1>
        <button
          type="button"
          aria-label="Close server settings"
          data-testid="serversettings-close"
          className={paneCloseButtonClass}
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6" data-testid="serversettings-content">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {phase === 'loading' ? (
            <p className="text-sm text-text-muted" data-testid="serversettings-loading">
              Loading configuration…
            </p>
          ) : null}

          {phase === 'load-error' ? (
            <p className="text-sm text-danger" role="alert" data-testid="serversettings-error">
              {error}
            </p>
          ) : null}

          {doc && phase !== 'load-error' ? (
            <>
              <p className="text-sm text-text-muted">
                The server's editable configuration. Secrets are not shown or editable here — they live in a
                separate file on the server. Keys marked <strong>boot</strong> take effect on restart; other
                keys apply as soon as you save.
              </p>

              <textarea
                aria-label="Server configuration JSON"
                data-testid="serversettings-editor"
                className="h-96 w-full resize-y rounded-md border border-border bg-surface p-3 font-mono text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                spellCheck={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />

              {doc.metadata && Object.keys(doc.metadata).length > 0 ? (
                <details className="text-sm text-text-muted" data-testid="serversettings-keys-help">
                  <summary className="cursor-pointer select-none">Key reference</summary>
                  <dl className="mt-2 flex flex-col gap-3">
                    {Object.entries(doc.metadata).map(([keyPath, meta]) => (
                      <div key={keyPath}>
                        <dt className="font-mono text-xs text-text-primary">
                          {keyPath}{' '}
                          <span className="ml-1 rounded bg-surface-hover px-1 text-[10px] uppercase">
                            {meta.scope}
                          </span>
                        </dt>
                        <dd className="mt-0.5">
                          {meta.description} <em className="not-italic text-text-muted">({meta.type})</em>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}

              {error ? (
                <p className="text-sm text-danger" role="alert" data-testid="serversettings-save-error">
                  {error}
                </p>
              ) : null}

              {notice && !restartRequired ? (
                <p className="text-sm text-success" role="status" data-testid="serversettings-saved">
                  {notice}
                </p>
              ) : null}

              {restartRequired ? (
                <div
                  className="flex flex-col gap-2 rounded-md border border-border p-3"
                  data-testid="serversettings-restart-prompt"
                >
                  <p className="text-sm text-text-primary">
                    A boot-scoped key changed — it takes effect when the server restarts. Restart now?
                  </p>
                  {notice ? <p className="text-sm text-text-muted">{notice}</p> : null}
                  {phase === 'restarting' ? (
                    <p className="text-sm text-text-muted" data-testid="serversettings-restarting">
                      Restarting — waiting for the server to come back…
                    </p>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                        data-testid="serversettings-restart-now"
                        onClick={() => void handleRestartNow()}
                      >
                        Restart now
                      </button>
                      <button
                        type="button"
                        className="rounded-md border border-border px-3 py-1.5 text-sm text-text-muted hover:bg-surface-hover"
                        data-testid="serversettings-restart-later"
                        onClick={() => setRestartRequired(false)}
                      >
                        Later
                      </button>
                    </div>
                  )}
                </div>
              ) : null}

              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  data-testid="serversettings-save"
                  disabled={phase !== 'ready'}
                  onClick={() => void handleSave()}
                >
                  {phase === 'saving' ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border px-4 py-2 text-sm text-text-muted hover:bg-surface-hover disabled:opacity-50"
                  data-testid="serversettings-cancel"
                  disabled={phase !== 'ready' && phase !== 'saving'}
                  onClick={() => void handleCancel()}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Poll `GET {origin}/health` — liveness answers 200 the moment HTTP is up. */
async function defaultPollHealth(signal: AbortSignal): Promise<boolean> {
  const res = await fetch(`${globalThis.location.origin}/health`, { signal });
  return res.ok;
}

function defaultReload(): void {
  globalThis.location.reload();
}
