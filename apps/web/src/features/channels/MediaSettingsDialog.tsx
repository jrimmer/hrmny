/**
 * @cytale/web — workspace Media settings dialog (calls V2 plan U8, R16).
 *
 * The owner/admin surface for the workspace's MASTER media toggles: calls,
 * video, screenshare, and the "allow channel overrides" flag — a small
 * modal panel reached from the WorkspaceMenu ("Media settings"), styled
 * with shell tokens only.
 *
 * States-first DoD:
 *   loading — skeleton note while GET /workspaces/{id}/media-settings runs
 *   denied  — 403 (member without manage_workspace): permission copy
 *   error   — any other failure, with Retry
 *   offline — the browser reports no network (warning copy, Retry)
 *   ready   — four role=switch toggles, optimistic with rollback (the
 *             notificationMute pattern): a failed PUT reverts the row and
 *             renders the inline alert
 *   (empty is n/a — the settings shape is always the full four-switch map;
 *   the server's absent-row defaults render as the initial positions)
 *
 * The dialog self-contains its api seam (like notificationMute.ts): the
 * host only supplies the workspace id; permission honesty comes from the
 * server's 403, never a client-side guess.
 */

import { useEffect, useState } from 'react';

import type { WorkspaceMediaSettings } from '@cytale/api-client';

import { api } from '../auth/session.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

export interface MediaSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active workspace (null while bootstrapping — the dialog stays loading). */
  workspaceId: string | null;
}

type Phase = 'loading' | 'ready' | 'denied' | 'error' | 'offline';

interface ToggleSpec {
  key: keyof WorkspaceMediaSettings;
  label: string;
  hint: string;
  testId: string;
}

const TOGGLES: ToggleSpec[] = [
  {
    key: 'calls',
    label: 'Calls',
    hint: 'Members can start calls in this workspace.',
    testId: 'media-settings-toggle-calls',
  },
  {
    key: 'video',
    label: 'Video',
    hint: 'Members can publish their camera in calls.',
    testId: 'media-settings-toggle-video',
  },
  {
    key: 'screenshare',
    label: 'Screenshare',
    hint: 'Members can share their screen (with audio) in calls.',
    testId: 'media-settings-toggle-screenshare',
  },
  {
    key: 'overrides_allowed',
    label: 'Allow channel overrides',
    hint: 'Channel managers may flip each capability per channel. When off, these workspace-wide values apply everywhere.',
    testId: 'media-settings-toggle-overrides',
  },
];

const DEFAULTS: WorkspaceMediaSettings = {
  calls: true,
  video: true,
  screenshare: true,
  overrides_allowed: false,
};

export function MediaSettingsDialog({ open, onOpenChange, workspaceId }: MediaSettingsDialogProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [settings, setSettings] = useState<WorkspaceMediaSettings>(DEFAULTS);
  const [pendingKey, setPendingKey] = useState<keyof WorkspaceMediaSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The one fetch path both the open-effect and Retry ride. `isCancelled`
  // guards the effect's stale-resolve race (a fast workspace switch).
  const load = (isCancelled: () => boolean = () => false) => {
    if (workspaceId == null) return;
    setPhase('loading');

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setPhase('offline');
      return;
    }

    api
      .getWorkspaceMediaSettings(workspaceId)
      .then((s) => {
        if (!isCancelled()) {
          setSettings(s);
          setPhase('ready');
        }
      })
      .catch((err: unknown) => {
        if (isCancelled()) return;
        const status = (err as { status?: number } | null)?.status;
        if (status === 403) {
          setPhase('denied');
        } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          setPhase('offline');
        } else {
          setPhase('error');
        }
      });
  };

  // Fresh fetch every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPhase('loading');
    setPendingKey(null);
    setError(null);

    if (workspaceId == null) return;

    let cancelled = false;
    load(() => cancelled);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId]);

  const retry = () => load();

  /** Optimistic toggle → PUT → keep or revert + inline alert. */
  const toggle = async (spec: ToggleSpec) => {
    if (workspaceId == null || pendingKey != null) return;
    const current = settings[spec.key];
    const next = !current;

    setSettings((s) => ({ ...s, [spec.key]: next }));
    setPendingKey(spec.key);
    setError(null);

    try {
      const merged = await api.putWorkspaceMediaSettings(workspaceId, { [spec.key]: next });
      setSettings(merged); // the server echo is authoritative
    } catch (err) {
      setSettings((s) => ({ ...s, [spec.key]: current }));
      const message = (err as { message?: string } | null)?.message;
      setError(
        message && message !== 'Request denied.'
          ? `Could not save: ${message}`
          : 'Could not save the setting — check your connection and try again.',
      );
    } finally {
      setPendingKey(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* showCloseButton={false}: the house ✕ below keeps its own styling;
          the wrapper's default close would duplicate it. */}
      <DialogContent
        className="modal-panel"
        showCloseButton={false}
        aria-describedby={undefined}
          data-testid="media-settings-dialog"
        >
          <DialogTitle className="modal-title">Media Settings</DialogTitle>
          <DialogClose className="modal-close" aria-label="Close">
            ✕
          </DialogClose>

          <p className="modal-explainer">
            Workspace-wide defaults for calls, video, and screenshare. Applies to new starts and
            publishes — live calls are never evicted.
          </p>

          {phase === 'loading' ? (
            <p role="status" data-testid="media-settings-loading" className="modal-explainer">
              Loading media settings…
            </p>
          ) : null}

          {phase === 'denied' ? (
            <p role="alert" data-testid="media-settings-denied" className="modal-error">
              You don&apos;t have permission to manage media settings in this workspace. Only the
              workspace owner or admins may change them.
            </p>
          ) : null}

          {phase === 'offline' ? (
            <div
              role="alert"
              data-testid="media-settings-offline"
              className="media-settings-note"
            >
              <p>You&apos;re offline — media settings can&apos;t be loaded right now.</p>
              <button type="button" className="modal-btn-secondary" onClick={retry}>
                Retry
              </button>
            </div>
          ) : null}

          {phase === 'error' ? (
            <div role="alert" data-testid="media-settings-error" className="media-settings-note">
              <p>Could not load media settings.</p>
              <button type="button" className="modal-btn-secondary" onClick={retry}>
                Retry
              </button>
            </div>
          ) : null}

          {phase === 'ready' ? (
            <div className="media-settings-list" data-testid="media-settings-list">
              {TOGGLES.map((spec) => (
                <div className="media-toggle-row" key={spec.key}>
                  <span className="media-toggle-text">
                    <span className="media-toggle-label">{spec.label}</span>
                    <span className="media-toggle-hint">{spec.hint}</span>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings[spec.key]}
                    aria-label={spec.label}
                    data-testid={spec.testId}
                    data-state={settings[spec.key] ? 'on' : 'off'}
                    className="media-toggle-switch"
                    disabled={pendingKey != null}
                    onClick={() => void toggle(spec)}
                  >
                    <span className="media-toggle-knob" aria-hidden="true" />
                    <span className="sr-only">{settings[spec.key] ? 'On' : 'Off'}</span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {error ? (
            <p role="alert" data-testid="media-settings-save-error" className="modal-error">
              {error}
            </p>
          ) : null}

          <div className="modal-actions">
            <DialogClose asChild>
              <button type="button" className="modal-btn-secondary" data-testid="media-settings-close">
                Close
              </button>
            </DialogClose>
          </div>
      </DialogContent>
    </Dialog>
  );
}
