/**
 * @cytale/web — AgentsSection: the machine credentials the caller owns.
 *
 * The ONE management surface for an agent (plan 2026-09-15-1200, KD1). It was
 * the rail overlay's bots pane; the rail surface is gone, so this is where an
 * agent is minted, renamed, granted, rotated and revoked. The settings rollup
 * that used to sit beside it (read-only, and wrong about what a grant meant)
 * is deleted — duplication was the thing the owner named, and a rollup whose
 * only action was a jump to the real surface was the duplication.
 *
 * User-owned management over `/bots` (any verified human, for
 * themselves — no workspace permission gate, so this section is always
 * accessible; an unverified account gets the 403 `ACCOUNT_UNVERIFIED`
 * permission-denied alert).
 *
 * Minting takes a NAME and nothing else: a bot starts at no access (R6),
 * and the grant is a separate, explicit act on its row. The row's editor is
 * `AccessTree` — the whole document, saved whole. Unsaved edits are DIRTY and
 * the pane reports dirtiness upward (`onDirtyChange`) so the
 * host can block a section switch behind an inline confirm-discard. Regenerate/revoke confirm
 * inline with consequence copy.
 */

import { useCallback, useEffect, useState } from 'react';

import { StateBanner } from '../../app/ui/StateBanner.js';
import { primaryButtonClass } from '../../app/ui/button.js';
import type { AccessDocument } from '@cytale/api-client';

import { Avatar } from '../../app/ui/UserAvatar.js';

import * as integrationsApi from './api.js';
import type { Bot } from './api.js';
import { AccessTree, describeAccess, emptyAccessDocument } from './AccessTree.js';
import type { ChannelOption, TreeWorkspace } from './types.js';
import { InlineConfirm } from './InlineConfirm.js';
import { PaneEmpty, PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { TokenReveal } from './TokenReveal.js';
import { usePaneList } from './usePaneList.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/shadcn/dialog.js';

export interface AgentsSectionProps {
  /** The caller's workspaces — the tree's grant targets (R5). */
  workspaces: TreeWorkspace[];
  /** One workspace's channels, for the tree's per-channel levels. */
  loadChannels(workspaceId: string): Promise<ChannelOption[]>;
  online: boolean;
  /** Dirty-guard seam: the panel blocks pane switches while true. */
  onDirtyChange?: (dirty: boolean) => void;
}

interface EditorDraft {
  botId: string;
  /** The whole document being edited — one save path (KTD5). */
  access: AccessDocument;
  /** Serialized as loaded — the dirty diff baseline. */
  baseline: string;
}

function accessKey(access: AccessDocument): string {
  return JSON.stringify(access);
}

export function AgentsSection({ workspaces, loadChannels, online, onDirtyChange }: AgentsSectionProps) {
  // Mint form.
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Row access editor (the tree).
  const [editor, setEditor] = useState<EditorDraft | null>(null);

  // The once-only reveal moment (create or regenerate).
  const [reveal, setReveal] = useState<{ title: string; token: string } | null>(null);

  // Row avatar (#126): upload/remove, mirroring the account avatar's
  // Upload/Remove affordance. Owner-set — a credential cannot upload for
  // itself — and display-only: the seal and the tag stay the identity marks.
  const [avatarBusyFor, setAvatarBusyFor] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const handleAvatarUpload = async (botId: string, file: File) => {
    setAvatarBusyFor(botId);
    setAvatarError(null);
    try {
      await integrationsApi.setBotAvatar(botId, file);
      reload();
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Could not upload the avatar.');
    } finally {
      setAvatarBusyFor(null);
    }
  };

  const handleAvatarRemove = async (botId: string) => {
    setAvatarBusyFor(botId);
    setAvatarError(null);
    try {
      await integrationsApi.clearBotAvatar(botId);
      reload();
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Could not remove the avatar.');
    } finally {
      setAvatarBusyFor(null);
    }
  };

  // Inline rename (one row at a time): renames the DISPLAY NAME only — the
  // tag is set at mint and never changes.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  // Mint confirmation: the Mint button opens the dialog; the POST fires on
  // confirm. The preview tag is the client's mirror of the server's
  // derivation — a PREVIEW, not a promise: a taken tag is refused and the
  // form says so (nothing is ever silently renamed).
  const [confirming, setConfirming] = useState(false);

  const listBots = useCallback(() => integrationsApi.listBots(), []);
  const {
    items: bots,
    loadState,
    permissionDenied,
    reload,
    setError,
  } = usePaneList(listBots, { errorFallback: 'Could not load your agents.' });

  // Dirty-guard seam: report editor dirtiness whenever the draft moves.
  const dirty = editor != null && accessKey(editor.access) !== editor.baseline;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const mintValid = name.trim() !== '';

  // The server's derivation rule, mirrored for the confirmation preview.
  const previewTag = (raw: string): string => {
    const slug = raw
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28);
    const filled = slug.length >= 2 ? slug : `bot-${slug}`.replace(/^-+|-+$/g, '');
    return filled;
  };

  const trimmedName = name.trim();
  const trimmedTag = username.trim();
  const preview = trimmedTag !== '' ? trimmedTag : previewTag(trimmedName);

  const create = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      setCreateError('Give the agent a name.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      // R6: a bot is minted with NO access. The grant is a separate,
      // explicit act — never a side effect of creating the credential.
      // The tag the user typed RIDES THE REQUEST — the dialog previewed it,
      // so dropping it here would mint a different credential than the one
      // confirmed (exactly the bug this line once shipped).
      const minted = await integrationsApi.createBot({
        name: trimmed,
        ...(trimmedTag !== '' ? { username: trimmedTag } : {}),
      });
      setReveal({ title: 'Agent token', token: minted.token });
      setName('');
      setUsername('');
      reload();
    } catch (err) {
      setConfirming(false);
      setCreateError(err instanceof Error ? err.message : 'Could not create the agent.');
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (bot: Bot) => {
    const access = bot.access ?? emptyAccessDocument();
    setEditor({ botId: bot.id, access, baseline: accessKey(access) });
  };

  const saveEdit = async () => {
    if (editor == null) return;
    try {
      await integrationsApi.updateBot(editor.botId, { access: editor.access });
      setEditor(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the access.');
    }
  };

  const rename = async (botId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed === '') {
      setRenameError('Give the agent a name.');
      return;
    }
    try {
      await integrationsApi.updateBot(botId, { name: trimmed });
      setRenamingId(null);
      setRenameError(null);
      reload();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Could not rename the agent.');
    }
  };

  const regenerate = async (botId: string) => {
    try {
      const res = await integrationsApi.regenerateBotToken(botId);
      setReveal({ title: 'New agent token', token: res.token });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not regenerate the token.');
    }
  };

  const revoke = async (botId: string) => {
    try {
      await integrationsApi.deleteBot(botId);
      if (editor?.botId === botId) setEditor(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke the agent.');
    }
  };

  const editError = null;

  return (
    <div data-testid="bots-pane" className="flex flex-col gap-4">
      {!online ? (
        <StateBanner tone="warning" testId="bots-offline">
          You are offline — destructive actions are disabled until the connection returns.
        </StateBanner>
      ) : null}

      {permissionDenied != null ? (
        <StateBanner tone="danger" testId="bots-permission-denied">
          {/* 6.4 rename window: both spellings until no pre-rename bundle can be live. */}
          {permissionDenied.key === 'account_unverified' ||
          permissionDenied.key === 'ACCOUNT_UNVERIFIED'
            ? 'Verify your email before minting agents — agent credentials are for verified humans.'
            : 'You do not have permission to manage agents.'}
        </StateBanner>
      ) : loadState.kind === 'loading' ? (
        <PaneSkeleton label="Loading your agents" testId="bots-loading" />
      ) : loadState.kind === 'error' ? (
        <PaneErrorBanner
          testId="bots-error"
          retryTestId="bots-retry"
          message={loadState.message}
          onRetry={reload}
        />
      ) : (
        <>
          <section aria-label="Mint an agent" className="rounded-md border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold text-text-primary">Mint an agent</h3>
            <p className="mt-0.5 text-sm text-text-muted">
              A credential with its own identity. It starts with no access — grant it below.
            </p>
            <div className="mt-2 flex flex-wrap items-start gap-2">
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <label htmlFor="bot-name" className="sr-only">
                  Agent name
                </label>
                <input
                  id="bot-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. CI runner"
                  data-testid="bot-name-input"
                  className="min-h-10 rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                />
              </div>
              <div className="flex w-48 flex-col gap-1">
                <label htmlFor="bot-username" className="sr-only">
                  Tag (optional)
                </label>
                <input
                  id="bot-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Tag (optional)"
                  data-testid="bot-username-input"
                  className="min-h-10 rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                />
              </div>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={creating || !online || !mintValid}
                data-testid="bot-create"
                className={primaryButtonClass + (creating || !online || !mintValid ? ' cursor-not-allowed opacity-50' : '')}
              >
                {creating ? 'Minting…' : 'Mint agent'}
              </button>
            </div>
            {createError ? (
              <p role="alert" className="mt-2 text-sm text-danger" data-testid="bot-create-error">
                {createError}
              </p>
            ) : null}

            <Dialog
              open={confirming}
              onOpenChange={(o) => (o ? undefined : setConfirming(false))}
            >
              <DialogContent
                aria-label="Confirm mint"
                data-testid="bot-mint-dialog"
                showCloseButton={false}
                overlayClassName="z-[70]"
                overlayTestId="bot-mint-overlay"
                // The surface's own utilities ride through cn/twMerge over
                // the wrapper's baked ones; block/gap-0 neutralize the grid
                // stack (this dialog spaces itself with mt-*).
                className="block gap-0 left-1/2 top-1/2 z-[80] w-[min(92vw, 440px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface-strong p-5 shadow-2xl"
              >
                  <DialogTitle className="text-base font-semibold text-text-primary">
                    Mint this agent?
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-sm text-text-muted">
                    This creates a credential with its own identity and a once-only token.
                  </DialogDescription>

                  <dl className="mt-4 flex flex-col gap-2 text-sm" data-testid="bot-mint-summary">
                    <div className="flex items-baseline gap-2">
                      <dt className="min-w-14 text-text-muted">Name</dt>
                      <dd className="font-medium text-text-primary">{trimmedName}</dd>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <dt className="min-w-14 text-text-muted">Tag</dt>
                      <dd className="font-mono text-text-primary">@{preview}</dd>
                    </div>
                  </dl>
                  <p className="mt-2 text-xs text-text-muted">
                    {trimmedTag !== ''
                      ? 'Tag as you set it. If it is taken the mint is refused — nothing is renamed.'
                      : 'Tag derived from the name. If it is taken the mint is refused — pick a different name or set a tag.'}
                  </p>

                  <div className="mt-5 flex justify-end gap-2">
                    <DialogClose
                      data-testid="bot-mint-cancel"
                      className="rounded-md border border-line px-4 py-2 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                    >
                      Cancel
                    </DialogClose>
                    <button
                      type="button"
                      onClick={() => {
                        // Close FIRST: the reveal must never stack on top of
                        // the dialog that asked for it (the success path kept
                        // the dialog mounted — reported live).
                        setConfirming(false);
                        void create();
                      }}
                      disabled={creating || !online}
                      data-testid="bot-mint-confirm"
                      className={
                        primaryButtonClass + (creating || !online ? ' cursor-not-allowed opacity-50' : '')
                      }
                    >
                      {creating ? 'Minting…' : 'Mint agent'}
                    </button>
                  </div>
              </DialogContent>
            </Dialog>
          </section>

          <section aria-label="Your agents">
            <h3 className="sr-only">Your agents</h3>
            {bots.length === 0 ? (
              <PaneEmpty
                testId="bots-empty"
                title="No agents yet"
                hint="Mint one — it starts with no access, and gets a token to connect."
              />
            ) : (
              <ul className="flex flex-col gap-2" data-testid="bots-list">
                {bots.map((bot) => {
                  const editing = editor?.botId === bot.id;
                  return (
                    <li
                      key={bot.id}
                      data-testid={`bot-row-${bot.id}`}
                      className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <div className="flex items-start gap-3">
                          <Avatar
                            id={bot.id}
                            name={bot.name}
                            src={bot.avatar_url ?? undefined}
                            kind={bot.kind}
                            size={36}
                          />
                          <div className="flex min-w-40 flex-1 flex-col gap-1">
                          {renamingId === bot.id ? (
                            <div className="flex flex-col gap-1">
                              <label htmlFor={`bot-rename-${bot.id}`} className="sr-only">
                                Agent name
                              </label>
                              <input
                                id={`bot-rename-${bot.id}`}
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                data-testid={`bot-rename-input-${bot.id}`}
                                className="min-h-9 rounded-md border border-line bg-surface-strong px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                              />
                              {renameError ? (
                                <p role="alert" className="text-xs text-danger" data-testid={`bot-rename-error-${bot.id}`}>
                                  {renameError}
                                </p>
                              ) : null}
                            </div>
                          ) : (
                            <>
                              <p className="text-sm font-medium text-text-primary">{bot.name}</p>
                              <p className="font-mono text-xs text-text-muted">
                                {bot.username ? `@${bot.username}` : bot.id}
                              </p>
                            </>
                          )}
                          {/* Avatar (#126): upload/remove under the row's name —
                              the owner sets it; the seal overlays the image. */}
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={!online || avatarBusyFor === bot.id}
                              data-testid={`bot-avatar-${bot.id}`}
                              onClick={() => document.getElementById(`bot-avatar-input-${bot.id}`)?.click()}
                              className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {avatarBusyFor === bot.id ? 'Avatar…' : 'Upload avatar'}
                            </button>
                            {bot.avatar_url ? (
                              <button
                                type="button"
                                disabled={!online || avatarBusyFor === bot.id}
                                data-testid={`bot-avatar-remove-${bot.id}`}
                                onClick={() => void handleAvatarRemove(bot.id)}
                                className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Remove
                              </button>
                            ) : null}
                            <input
                              id={`bot-avatar-input-${bot.id}`}
                              type="file"
                              aria-label={`Upload an avatar for ${bot.name}`}
                              accept="image/png,image/jpeg,image/gif,image/webp"
                              className="sr-only"
                              data-testid={`bot-avatar-input-${bot.id}`}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) void handleAvatarUpload(bot.id, file);
                                e.target.value = '';
                              }}
                            />
                          </div>
                          {avatarError && avatarBusyFor === null ? (
                            <p role="alert" className="text-xs text-danger" data-testid={`bot-avatar-error-${bot.id}`}>
                              {avatarError}
                            </p>
                          ) : null}
                          </div>
                        </div>
                        <span
                          className="rounded-full border border-line px-2 py-0.5 text-xs text-text-muted"
                          data-testid={`bot-access-${bot.id}`}
                          title={describeAccess(bot.access)}
                        >
                          {describeAccess(bot.access)}
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          {renamingId === bot.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => void rename(bot.id)}
                                disabled={!online}
                                data-testid={`bot-rename-save-${bot.id}`}
                                className={primaryButtonClass + (!online ? ' cursor-not-allowed opacity-50' : '')}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setRenamingId(null);
                                  setRenameError(null);
                                }}
                                data-testid={`bot-rename-cancel-${bot.id}`}
                                className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setRenamingId(bot.id);
                                setRenameValue(bot.name);
                                setRenameError(null);
                              }}
                              disabled={!online}
                              data-testid={`bot-rename-${bot.id}`}
                              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                            >
                              Rename
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => (editing ? setEditor(null) : startEdit(bot))}
                            aria-expanded={editing}
                            data-testid={`bot-edit-${bot.id}`}
                            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                          >
                            {editing ? 'Close access editor' : 'Access'}
                          </button>
                          <InlineConfirm
                            label="Regenerate"
                            consequence="This disconnects the agent immediately — its current token stops working."
                            confirmLabel="Regenerate"
                            disabled={!online}
                            disabledReason="Wait for the connection to return."
                            onConfirm={() => void regenerate(bot.id)}
                            testId={`bot-regenerate-${bot.id}`}
                          />
                          <InlineConfirm
                            label="Revoke"
                            consequence="This disconnects the agent immediately and removes it."
                            confirmLabel="Revoke"
                            tone="danger"
                            disabled={!online}
                            disabledReason="Wait for the connection to return."
                            onConfirm={() => void revoke(bot.id)}
                            testId={`bot-revoke-${bot.id}`}
                          />
                        </div>
                      </div>

                      {editing && editor != null ? (
                        <div className="rounded-md border border-line bg-surface-strong p-3">
                          <p className="mb-2 text-sm font-medium text-text-primary">
                            Access for {bot.name}
                          </p>
                          {/*
                            The tree edits the whole grant and saves the whole
                            grant: one document, validated server-side, so a
                            node can never be half-applied. Access is what the
                            bot holds — not a filter over the owner's own
                            rights, which is what the old restrictions editor
                            expressed (and why it is gone: the resolver stopped
                            honouring that column for machine principals).
                          */}
                          <AccessTree
                            value={editor.access}
                            workspaces={workspaces}
                            loadChannels={loadChannels}
                            onChange={(next) =>
                              setEditor((d) => (d ? { ...d, access: next } : d))
                            }
                            disabled={!online}
                            idPrefix={`bot-edit-${bot.id}`}
                          />
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void saveEdit()}
                              disabled={!online || editError != null}
                              data-testid={`bot-edit-save-${bot.id}`}
                              className={
                                primaryButtonClass +
                                (!online || editError != null ? ' cursor-not-allowed opacity-50' : '')
                              }
                            >
                              Save access
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditor(null)}
                              data-testid={`bot-edit-cancel-${bot.id}`}
                              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      <TokenReveal
        open={reveal != null}
        title={reveal?.title ?? 'Agent token'}
        token={reveal?.token ?? ''}
        onDismiss={() => setReveal(null)}
        testId="bot-token-reveal"
      />
    </div>
  );
}
