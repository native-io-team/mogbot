/**
 * "Send to agent…": something shared into the app from another one (a page,
 * some text, photos or files), handed to an agent's composer for you to add
 * to and send. Nothing is sent on its own.
 *
 * Two ways in, one screen (`app/share.tsx`):
 * - the share sheet, through expo-share-intent's native extension, in a
 *   build that has it (docs/mobile.md, "Send to agent…");
 * - a link, `<scheme>://share?text=…&url=…&title=…`, which also works in
 *   Expo Go and is how the screen is tested.
 *
 * The parts here are pure: what was shared, as a draft's words and files.
 */

import type { PickedFile } from './files';

export interface SharedPayload {
  text?: string;
  url?: string;
  title?: string;
  files?: PickedFile[];
}

/** expo-share-intent's `ShareIntent`, as much of it as is read here. */
export interface IncomingShare {
  text?: string | null;
  webUrl?: string | null;
  meta?: { title?: string } | null;
  files?:
    | {
        path: string;
        fileName: string;
        mimeType: string;
        size: number | null;
        width: number | null;
        height: number | null;
      }[]
    | null;
}

/** Shared text longer than this is cut: a message is 20k characters at most. */
const MAX_TEXT = 8_000;

const clean = (s: string | null | undefined) => {
  // Control characters are what the Mac refuses in a message; tabs and newlines stay.
  // eslint-disable-next-line no-control-regex
  const t = s?.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return t ? t.slice(0, MAX_TEXT) : undefined;
};

/** What the share extension handed over, as the share screen's payload. */
export function fromShareIntent(s: IncomingShare): SharedPayload {
  const url = clean(s.webUrl);
  let text = clean(s.text);
  // iOS hands a shared page over as its address in `text` too: say it once.
  if (text && url && text === url) text = undefined;
  const files = (s.files ?? []).map((f) => ({
    uri:
      f.path.startsWith('file://') || f.path.startsWith('content://') ? f.path : `file://${f.path}`,
    name: f.fileName || f.path.split('/').pop() || 'file',
    mime: f.mimeType || 'application/octet-stream',
    ...(f.size != null ? { size: f.size } : {}),
    ...(f.width != null ? { width: f.width } : {}),
    ...(f.height != null ? { height: f.height } : {}),
  }));
  return {
    ...(text ? { text } : {}),
    ...(url ? { url } : {}),
    ...(clean(s.meta?.title) ? { title: clean(s.meta?.title) } : {}),
    ...(files.length ? { files } : {}),
  };
}

/** A file on this phone, as the share extension wrote it: never a remote URL. */
function isLocalFile(f: unknown): f is PickedFile {
  if (!f || typeof f !== 'object') return false;
  const { uri, name, mime } = f as Record<string, unknown>;
  return (
    typeof uri === 'string' &&
    /^(file|content):\/\//.test(uri) &&
    typeof name === 'string' &&
    typeof mime === 'string'
  );
}

/** The share screen's route params (strings), as a payload. Files ride as JSON. */
export function fromParams(p: Record<string, string | string[] | undefined>): SharedPayload {
  const one = (k: string) => {
    const v = p[k];
    return clean(Array.isArray(v) ? v[0] : v);
  };
  let files: PickedFile[] | undefined;
  const raw = one('files');
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) files = (parsed as unknown[]).filter(isLocalFile);
    } catch {
      files = undefined;
    }
  }
  const url = one('url');
  return {
    ...(one('text') ? { text: one('text') } : {}),
    ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
    ...(one('title') ? { title: one('title') } : {}),
    ...(files?.length ? { files } : {}),
  };
}

/** A payload as route params for `/share`. */
export function toParams(s: SharedPayload): Record<string, string> {
  return {
    ...(s.text ? { text: s.text } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.title ? { title: s.title } : {}),
    ...(s.files?.length ? { files: JSON.stringify(s.files) } : {}),
  };
}

export const isEmptyShare = (s: SharedPayload) => !s.text && !s.url && !s.files?.length;

/**
 * The shared words, as they go into the draft: the page's title and
 * address, then any text, after whatever was already typed there.
 */
export function shareText(s: SharedPayload, existing = ''): string {
  const link = s.url ? (s.title && s.title !== s.url ? `${s.title}\n${s.url}` : s.url) : '';
  const shared = [link, s.text ?? ''].filter(Boolean).join('\n\n');
  if (!shared) return existing;
  return existing.trim() ? `${existing.trimEnd()}\n\n${shared}` : shared;
}

/** "A link and 2 photos", for the share screen's heading. */
export function describeShare(s: SharedPayload): string {
  const files = s.files ?? [];
  const photos = files.filter((f) => f.mime.startsWith('image/')).length;
  const others = files.length - photos;
  const parts = [
    s.url ? 'a link' : null,
    s.text ? 'some text' : null,
    photos ? (photos === 1 ? 'a photo' : `${photos} photos`) : null,
    others ? (others === 1 ? 'a file' : `${others} files`) : null,
  ].filter((p): p is string => !!p);
  if (!parts.length) return 'Nothing';
  const sentence =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return sentence[0].toUpperCase() + sentence.slice(1);
}
