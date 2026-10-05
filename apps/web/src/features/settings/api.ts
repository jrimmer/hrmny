/**
 * @cytale/web — Integrations surface API wrapper (U13).
 *
 * Thin, typed seam over the shared session api-client (the same instance
 * useMessages/useThreads consume). The management REST contract is the
 * shipped bots/webhooks surface (docs/protocol/rest.md):
 *
 *   bots     /bots[/{bot}][/regenerate]                  (user-owned)
 *   webhooks /channels/{id}/webhooks[/{hook}]            (manage_channels)
 *
 * Envelope unwrapping lives in the api-client; this module exists so the
 * panes import one feature-local surface (mockable as a unit, documented in
 * one place) and never the session module directly. Errors surface as the
 * client's typed `ApiError` — panes narrow on `.status` (403 →
 * permission-denied) and `.key` (ACCOUNT_UNVERIFIED).
 */

import { api } from '../auth/session.js';
import type {
  Bot,
  CreatedWebhook,
  CreatePrincipalBody,
  CreateWebhookBody,
  MintedPrincipalCredential,
  MyWebhook,
  PrincipalRestrictions,
  RegeneratedCredential,
  UpdatePrincipalBody,
  UpdateWebhookBody,
  Webhook,
} from '@cytale/api-client';

export type {
  Bot,
  CreatedWebhook,
  CreatePrincipalBody,
  CreateWebhookBody,
  MintedPrincipalCredential,
  MyWebhook,
  PrincipalRestrictions,
  RegeneratedCredential,
  UpdatePrincipalBody,
  UpdateWebhookBody,
  Webhook,
};

// -- bots (user-owned) -------------------------------------------------------
// There is no workspace-scoped bot surface any more: a bot is always
// user-owned, and its workspaces are grants in its access document.

// -- agents (user scope) ------------------------------------------------------

export function createBot(body: CreatePrincipalBody): Promise<MintedPrincipalCredential> {
  return api.createBot(body);
}

export function listBots(): Promise<Bot[]> {
  return api.listBots();
}

export function updateBot(agentId: string, body: UpdatePrincipalBody): Promise<Bot> {
  return api.updateBot(agentId, body);
}

export function regenerateBotToken(agentId: string): Promise<RegeneratedCredential> {
  return api.regenerateBotToken(agentId);
}

export function setBotAvatar(botId: string, file: File): Promise<Bot> {
  return api.setBotAvatar(botId, file);
}

export function clearBotAvatar(botId: string): Promise<Bot> {
  return api.clearBotAvatar(botId);
}

export function deleteBot(agentId: string): Promise<void> {
  return api.deleteBot(agentId);
}

// -- webhooks (channel scope) -------------------------------------------------

/** The create response is `{id, url}` — the capability URL, handed over ONCE. */
export function createWebhook(channelId: string, body: CreateWebhookBody): Promise<CreatedWebhook> {
  return api.createWebhook(channelId, body);
}

/** The caller's OWN webhooks, with URLs and destination names (KD2). */
export function listMyWebhooks(): Promise<MyWebhook[]> {
  return api.listMyWebhooks();
}

export function updateMyWebhook(webhookId: string, body: UpdateWebhookBody): Promise<MyWebhook> {
  return api.updateMyWebhook(webhookId, body);
}

export function deleteMyWebhook(webhookId: string): Promise<void> {
  return api.deleteMyWebhook(webhookId);
}

export function listWebhooks(channelId: string): Promise<Webhook[]> {
  return api.listWebhooks(channelId);
}

export function updateWebhook(channelId: string, webhookId: string, body: UpdateWebhookBody): Promise<Webhook> {
  return api.updateWebhook(channelId, webhookId, body);
}

export function deleteWebhook(channelId: string, webhookId: string): Promise<void> {
  return api.deleteWebhook(channelId, webhookId);
}
