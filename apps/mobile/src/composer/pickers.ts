/**
 * @cytale/mobile — attachment pickers (plan 004 M7, R10).
 *
 * The only module that touches `expo-image-picker` / `expo-document-picker`.
 * Each adapter normalizes its result to the `PickedAttachment` descriptor the
 * upload path and the prefilter speak, and each resolves to `[]` on cancel —
 * never throws for a user-cancelled sheet (an error is a real failure, and
 * the composer surfaces it as one).
 *
 * The document picker is given the server's mime allowlist so the system UI
 * pre-filters; the composer's own prefilter still runs (pickers on Android
 * can hand back types outside the requested set).
 */

import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { ALLOWED_UPLOAD_MIME } from './attachmentRules';
import type { PickedAttachment } from './types';

/** Extension for a nameless asset, derived from its mime (or a safe default). */
function extensionFor(mime: string | undefined, fallback: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return fallback;
  }
}

/** Mint a stable, honest name for an asset whose picker withheld one. */
function fallbackName(prefix: string, mime: string | undefined): string {
  return `${prefix}-${Date.now()}.${extensionFor(mime, 'png')}`;
}

function normalizeImageAsset(asset: ImagePicker.ImagePickerAsset, seq: number): PickedAttachment {
  const mime = asset.mimeType ?? 'image/jpeg';
  return {
    uri: asset.uri,
    name: asset.fileName ?? fallbackName(`photo-${seq}`, mime),
    type: mime,
    size: asset.fileSize ?? null,
  };
}

/**
 * iOS hands photos from the library/Files over as HEIC when the device keeps
 * HEIF — a format the server's upload allowlist refuses. Convert to JPEG at
 * the intake: the bytes never leave the device in a format that would be
 * rejected, and the staged attachment reads as a normal JPEG downstream.
 */
const HEIC_MIME = new Set(['image/heic', 'image/heif']);

function isHeic(picked: { type: string; name?: string }): boolean {
  if (HEIC_MIME.has(picked.type)) return true;
  const lower = (picked.name ?? '').toLowerCase();
  return lower.endsWith('.heic') || lower.endsWith('.heif');
}

async function toJpeg(picked: PickedAttachment): Promise<PickedAttachment> {
  const converted = await ImageManipulator.manipulateAsync(picked.uri, [], {
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return {
    ...picked,
    uri: converted.uri,
    type: 'image/jpeg',
    name: picked.name.replace(/\.(heic|heif)$/i, '.jpg'),
    size: null,
  };
}

/** Convert HEIC/HEIF picks to JPEG in place; everything else passes through. */
async function normalizeToUploadable(attachments: PickedAttachment[]): Promise<PickedAttachment[]> {
  const out: PickedAttachment[] = [];
  for (const picked of attachments) {
    out.push(isHeic(picked) ? await toJpeg(picked) : picked);
  }
  return out;
}

/** Photo library (multi-select). */
export async function pickFromLibrary(): Promise<PickedAttachment[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    quality: 1,
  });
  if (result.canceled) return [];
  return normalizeToUploadable(
    result.assets.map((asset, i) => normalizeImageAsset(asset, i + 1)),
  );
}

/** Camera capture (single shot). */
export async function pickFromCamera(): Promise<PickedAttachment[]> {
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  if (result.canceled) return [];
  return result.assets.map((asset, i) => normalizeImageAsset(asset, i + 1));
}

/** Files app (multi-select), pre-filtered to the server allowlist. */
export async function pickFiles(): Promise<PickedAttachment[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...ALLOWED_UPLOAD_MIME, 'image/heic', 'public.heic'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return normalizeToUploadable(
    result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? '',
      size: asset.size ?? null,
    })),
  );
}
