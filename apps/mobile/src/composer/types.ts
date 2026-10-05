/**
 * @cytale/mobile — composer contracts (plan 004 M7).
 *
 * `ReplyTarget` is re-exported from the M8 seam
 * (`apps/mobile/src/messages/replyTarget.ts`) — the action sheet builds
 * targets there and the channel route feeds them here, so there is exactly
 * one declaration of the shape across the two units.
 */

import type { UploadedAttachment } from '@cytale/api-client';

export type { ReplyTarget } from '../messages/replyTarget';

/**
 * A file a picker handed us, normalized to RN's `{uri, name, type}`
 * descriptor plus the size the prefilter needs. `size` is null when the
 * picker could not report it — the size gate is skipped rather than
 * rejecting a file we know nothing about (the server still enforces the cap).
 */
export interface PickedAttachment {
  uri: string;
  name: string;
  type: string;
  size: number | null;
}

/** One staged chip: an upload in one of three states (web's `StagedAttachment`). */
export interface StagedAttachment {
  /** Stable chip identity — the same file may be picked twice. */
  key: string;
  file: PickedAttachment;
  status: 'uploading' | 'done' | 'error';
  /** Upload result once `done` — bound into the send body. */
  attachment?: UploadedAttachment;
  /** Inline error text once `error`. */
  error?: string;
  /**
   * True when the error is an upload FAILURE (retryable). A prefilter
   * rejection (blocked type / oversize) sets it false — retrying the same
   * bytes would fail identically.
   */
  retryable?: boolean;
}

/** The send seam the composer calls (injectable for tests). */
export interface SendInput {
  channelId: string;
  threadId: string | null;
  content: string;
  replyToId?: string | null;
  attachments?: UploadedAttachment[];
}

export type SendMessage = (input: SendInput) => Promise<void>;

/** The upload seam the tray drives (injectable for tests). */
export type UploadAttachment = (
  channelId: string,
  file: PickedAttachment,
) => Promise<UploadedAttachment>;

/** A picker seam: resolves to the picked files (empty when cancelled). */
export type PickAttachments = () => Promise<PickedAttachment[]>;
