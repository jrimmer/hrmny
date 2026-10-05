/**
 * U13 — voice-room provisioning via the REAL REST seam (@cytale/api-client).
 *
 * Registers + email-verifies one owner and N member users against a live
 * server (the dev mailbox file the soak script uses), creates a workspace +
 * channel, has every member accept an invite, and resolves each user's id
 * via GET /users/@me. Returns per-user gateway auth tokens for the sidecar /
 * virtual voice clients.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CytaleApiClient } from '@cytale/api-client';

import { REPO_ROOT } from './sidecar.js';
import type { ProvisionedVoiceRoom } from './types.js';

/** Dev mailbox the server's auth flow writes verification mails to. */
export const MAILBOX_PATH = join(REPO_ROOT, 'apps/server/tmp/dev_mailbox.jsonl');

export interface ProvisionOptions {
  /** REST base, e.g. http://127.0.0.1:4100/api/v1. */
  apiBaseUrl: string;
  /** Member users to provision (besides the owner). */
  userCount: number;
  /** Unique label fragment (a timestamp suffix is added automatically). */
  label: string;
  /** Mailbox path override (tests). */
  mailboxPath?: string;
}

async function makeVerifiedUser(
  apiBaseUrl: string,
  mailboxPath: string,
  label: string,
): Promise<{ api: CytaleApiClient; access(): string }> {
  const tokens: { access?: string; refresh?: string } = {};
  const api = new CytaleApiClient({
    baseUrl: apiBaseUrl,
    tokens: {
      getAccessToken: async () => tokens.access ?? '',
      getRefreshToken: async () => tokens.refresh ?? '',
      updateTokens: async (a, r) => {
        tokens.access = a;
        tokens.refresh = r;
      },
    },
  });

  const registered = await api.register({
    username: label,
    email: `${label}@voice.local`,
    password: 'voice-password-1',
  });
  tokens.access = registered.access_token;
  tokens.refresh = registered.refresh_token;

  const mails = readFileSync(mailboxPath, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { to: string; kind: string; token: string })
    .filter((m) => m.to === `${label}@voice.local` && m.kind === 'verify_email');
  const mail = mails.at(-1);
  if (!mail) throw new Error(`no verify mail for ${label} in ${mailboxPath}`);
  await api.verifyEmail({ token: mail.token });
  const re = await api.login({ identifier: label, password: 'voice-password-1' });
  tokens.access = re.access_token;
  tokens.refresh = re.refresh_token;
  return { api, access: () => tokens.access ?? '' };
}

/** Provision a complete voice room (owner + members + channel). */
export async function provisionVoiceRoom(options: ProvisionOptions): Promise<ProvisionedVoiceRoom> {
  const mailbox = options.mailboxPath ?? MAILBOX_PATH;
  const run = `voice_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;

  const owner = await makeVerifiedUser(options.apiBaseUrl, mailbox, `own_${run}`);
  const meRaw = (await owner.api.getCurrentUser()) as unknown as { id?: string; user?: { id?: string } };
  const ownerId = meRaw.id ?? meRaw.user?.id;
  if (!ownerId) throw new Error(`getCurrentUser returned no id: ${JSON.stringify(meRaw).slice(0, 200)}`);

  const workspace = await owner.api.createWorkspace({ name: `voice-${run}` });
  const channel = await owner.api.createChannel(workspace.id, { name: 'voice' });

  const inviteRes = await fetch(`${options.apiBaseUrl}/workspaces/${workspace.id}/invites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.access()}` },
    body: '{}',
  });
  if (!inviteRes.ok) throw new Error(`invite create ${inviteRes.status}`);
  const invite = (await inviteRes.json()) as { invite: { code: string } };

  const members: Array<{ api: CytaleApiClient; access(): string; id: string }> = [];
  for (let i = 0; i < options.userCount; i++) {
    const member = await makeVerifiedUser(options.apiBaseUrl, mailbox, `usr_${run}_${i}`);
    const accept = await fetch(`${options.apiBaseUrl}/invites/${invite.invite.code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${member.access()}` },
    });
    if (!accept.ok) throw new Error(`invite accept ${accept.status}`);
    const memberMe = (await member.api.getCurrentUser()) as unknown as { id?: string; user?: { id?: string } };
    const memberId = memberMe.id ?? memberMe.user?.id;
    if (!memberId) throw new Error(`member getCurrentUser returned no id: ${JSON.stringify(memberMe).slice(0, 200)}`);
    members.push({ ...member, id: String(memberId) });
  }

  return {
    workspaceId: String(workspace.id),
    channelId: String(channel.id),
    ownerToken: owner.access(),
    ownerUserId: String(ownerId),
    tokens: members.map((m) => m.access()),
    userIds: members.map((m) => m.id),
  };
}
