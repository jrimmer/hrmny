/**
 * @cytale/mobile — the native multipart attachment upload.
 *
 * The SDK 57 global fetch (the Expo winter fetch) cannot convert React
 * Native's `{uri}` FormData file parts — every upload died with
 * "Unsupported FormDataPart implementation" (device feedback, round 4).
 * `FileSystem.uploadAsync` performs the multipart POST natively, bypassing
 * JS fetch entirely: same route, same multipart envelope, same
 * {"attachment": …} envelope the api-client unwraps.
 */
import type { UploadedAttachment } from '@cytale/api-client';
import * as FileSystem from 'expo-file-system';
import { FileSystemUploadType } from 'expo-file-system/legacy';

import { currentServerOrigin } from '../navigation/session';

export interface NativeUploadDeps {
  /** The live access token (the auth store's `accessToken`). */
  accessToken: () => string | null;
}

export function createNativeUpload({ accessToken }: NativeUploadDeps) {
  return async function uploadChannelAttachment(
    channelId: string,
    file: { uri: string; name: string; type: string },
  ): Promise<UploadedAttachment> {
    const origin = currentServerOrigin();
    if (origin === undefined) {
      throw new Error('No server configured — set the server on the sign-in screen.');
    }
    const token = accessToken();
    const response = await FileSystem.uploadAsync(
      `${origin}/api/v1/channels/${channelId}/attachments`,
      file.uri,
      {
        fieldName: 'file',
        mimeType: file.type || 'application/octet-stream',
        httpMethod: 'POST',
        uploadType: FileSystemUploadType.MULTIPART,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
    );
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      // Non-JSON body: fall through to the status check.
    }
    if (response.status >= 400) {
      const shape = parsed as { error?: { message?: string }; message?: string } | null;
      const message =
        (shape as { error?: { message?: string } } | null)?.error?.message ??
        (parsed as { message?: string } | null)?.message ??
        `Upload failed (${response.status}).`;
      throw new Error(message);
    }
    const attachment = (parsed as { attachment?: UploadedAttachment } | null)?.attachment;
    if (attachment === undefined) {
      throw new Error('The upload response did not include the attachment.');
    }
    return attachment;
  };
}
