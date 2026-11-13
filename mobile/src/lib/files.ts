/**
 * Files on the phone: picking them (camera, Photos, Files) with the desktop's
 * limits, moving their bytes over HTTP (the transport's `HttpAdapter`), and
 * opening what the agent sent: images in the app's own viewer, everything
 * else in Quick Look.
 *
 * Downloads are cached by what they are (a blob id, or an agent and the
 * attachment's path), never by URL: an attachment never changes once sent,
 * and the same file comes back over a different route just the same.
 */

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, toBase64Url } from '@shipstudio/companion-protocol';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { fromBase64Url, standardToUrl } from './identity';
import type { HttpAdapter, LocalFiles } from './transport';

/** A file chosen on the phone, before it is uploaded. */
export interface PickedFile {
  uri: string;
  name: string;
  mime: string;
  /** Bytes, when the picker says; the Mac checks again either way. */
  size?: number;
  width?: number;
  height?: number;
}

const MB = 1024 * 1024;
const CACHE = `${FileSystem.cacheDirectory ?? ''}companion/`;

/** The desktop's wording (agents/attachments.rs), so both say the same thing. */
export const tooBig = (name: string, size: number) =>
  `${name} is ${Math.ceil(size / MB)} MB. Files can be up to ${MAX_ATTACHMENT_BYTES / MB} MB.`;

/**
 * Keep what fits: the first `room` files under the size limit. Returns the
 * kept files and one sentence about what was left out, if anything was, with
 * how many went in and the limit: a pick past the limit never adds nothing
 * without saying why.
 */
export function admit(
  files: PickedFile[],
  room: number
): { kept: PickedFile[]; refused: string | null } {
  const space = Math.max(0, Math.floor(Number.isFinite(room) ? room : 0));
  const big = files.find((f) => f.size != null && f.size > MAX_ATTACHMENT_BYTES);
  const fitting = files.filter((f) => f.size == null || f.size <= MAX_ATTACHMENT_BYTES);
  const kept = fitting.slice(0, space);
  const parts: string[] = [];
  if (big) parts.push(tooBig(big.name, big.size!));
  if (fitting.length > kept.length) parts.push(tooManyPicked(kept.length, fitting.length));
  return { kept, refused: parts.length ? parts.join(' ') : null };
}

/** More picked than there was room for: how many went in, of how many, and the limit. */
export function tooManyPicked(added: number, picked: number): string {
  if (added === 0) return full();
  return `Added ${added} of ${picked}. You can attach up to ${MAX_ATTACHMENTS} files at a time.`;
}

/** No room left at all: why nothing went in, and what to do. */
export const full = () =>
  `Nothing added: ${MAX_ATTACHMENTS} files are already attached, the most at a time. Send them or remove one first.`;

export const isImage = (mime: string) => mime.startsWith('image/');
/** Images the Mac can thumbnail and the phone can draw. */
export const isPreviewableImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|heic)$/.test(mime);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** "Report.PDF" → "PDF": the badge on a file chip. */
export const extensionOf = (name: string) =>
  name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE';

// ---- Picking ------------------------------------------------------------------

function fromAsset(a: ImagePicker.ImagePickerAsset): PickedFile {
  const fallback = a.type === 'video' ? 'video.mov' : 'photo.jpg';
  return {
    uri: a.uri,
    name: a.fileName ?? a.uri.split('/').pop() ?? fallback,
    mime: a.mimeType ?? (a.type === 'video' ? 'video/quicktime' : 'image/jpeg'),
    size: a.fileSize,
    width: a.width,
    height: a.height,
  };
}

/** Throws a sentence when the user said no to the permission. */
export async function takePhoto(): Promise<PickedFile[]> {
  const { granted } = await ImagePicker.requestCameraPermissionsAsync();
  if (!granted) throw new Error('This app can’t use the camera. Allow it in Settings.');
  const r = await ImagePicker.launchCameraAsync({ quality: 0.85 });
  return r.canceled ? [] : r.assets.map(fromAsset);
}

/**
 * Photos, at most `limit` of them: the picker itself stops at the limit
 * (`selectionLimit`). Never opened with no room: a `selectionLimit` of 0
 * means "no limit" to the picker, so that would let you pick any number
 * and then add none.
 */
export async function pickPhotos(limit: number): Promise<PickedFile[]> {
  const room = Math.floor(limit);
  if (!(room >= 1)) throw new Error(full());
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: room > 1,
    selectionLimit: room,
    quality: 0.9,
  });
  return r.canceled ? [] : (r.assets ?? []).map(fromAsset);
}

export async function pickDocuments(): Promise<PickedFile[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (r.canceled) return [];
  return r.assets.map((a) => ({
    uri: a.uri,
    name: a.name,
    mime: a.mimeType ?? 'application/octet-stream',
    size: a.size,
  }));
}

// ---- Bytes ----------------------------------------------------------------------

async function cachePath(key: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key);
  const name = key.split('/').pop() ?? 'file';
  return `${CACHE}${digest.slice(0, 24)}-${name.replace(/[^\w.-]/g, '_')}`;
}

export const http: HttpAdapter = {
  async upload(url, uri, headers, onProgress) {
    const task = FileSystem.createUploadTask(
      url,
      uri,
      { httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers },
      ({ totalBytesSent, totalBytesExpectedToSend }) =>
        onProgress?.(totalBytesExpectedToSend ? totalBytesSent / totalBytesExpectedToSend : 0)
    );
    const res = await task.uploadAsync();
    if (!res) throw new Error('Upload cancelled');
    return { status: res.status, body: res.body };
  },
  async download(url, headers, key) {
    const dest = await cachePath(key);
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists && info.size) return { status: 200, uri: dest };
    await FileSystem.makeDirectoryAsync(CACHE, { intermediates: true }).catch(() => {});
    const res = await FileSystem.downloadAsync(url, dest, { headers });
    if (res.status !== 200) await FileSystem.deleteAsync(dest, { idempotent: true });
    return { status: res.status, uri: res.uri };
  },
};

/** Standard base64, as expo-file-system reads and writes it, from bytes. */
const toBase64 = (bytes: Uint8Array) => {
  const url = toBase64Url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  return url + '='.repeat((4 - (url.length % 4)) % 4);
};

/**
 * The same files over the relay, where the transport moves the bytes itself
 * (`LocalFiles`): kept in the same cache, under the same keys, so a file
 * fetched over one route is there on the other.
 */
export const localFiles: LocalFiles = {
  async read(uri) {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    // expo-file-system writes standard base64 (`+`, `/`, padding, sometimes
    // line breaks); the decoder takes the URL-safe alphabet only.
    const bytes = fromBase64Url(standardToUrl(b64));
    if (!bytes) throw new Error('That file couldn’t be read.');
    return bytes;
  },
  async cached(key) {
    const dest = await cachePath(key);
    const info = await FileSystem.getInfoAsync(dest);
    return info.exists && info.size ? dest : null;
  },
  async write(key, bytes) {
    const dest = await cachePath(key);
    await FileSystem.makeDirectoryAsync(CACHE, { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(dest, toBase64(bytes), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return dest;
  },
};

/** Everything downloaded from this Mac. Forgetting the Mac wipes it. */
export const clearCache = () => FileSystem.deleteAsync(CACHE, { idempotent: true });

/** A file of the app's own it no longer needs (a voice message's audio, once sent). */
export const discardFile = (uri: string) =>
  FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});

// ---- Opening ------------------------------------------------------------------------

/** Quick Look on iOS (the system's own viewer); the share sheet where that isn't available. */
export async function preview(uri: string, mime: string): Promise<void> {
  try {
    await new File(uri).preview();
  } catch {
    await share(uri, mime);
  }
}

export async function share(uri: string, mime: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing isn’t available here.');
  await Sharing.shareAsync(uri, { mimeType: mime });
}
