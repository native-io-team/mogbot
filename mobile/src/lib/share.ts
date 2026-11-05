/**
 * "Send to agent…": something shared into the app from another one (a page,
 * some text, photos or files), handed to an agent's composer for you to add
 * to and send. Nothing is sent on its own.
 *
 * Two ways in, one screen (`app/share.tsx`):
 * - the share sheet, through expo-share-intent's native extension, in a
 *   build that has it (docs/mobile.md, "Send to agent…"). What it handed
 *   over waits here, in memory, under a one-time key (`stashShare`); the
 *   route carries only that key, `/share?k=…`;
 * - a link, `<scheme>://share?text=…&url=…&title=…`, which also works in
 *   Expo Go and is how the screen is tested. Any web page or app can open
 *   one, so it carries words only: never files (a link could otherwise name
 *   a file in the app's own storage and have it uploaded), and the screen
 *   says it came from a link.
 *
 * The parts here are pure: what was shared, as a draft's words and files.
 */

import type { PickedFile } from './files';

export interface SharedPayload {
  text?: string;
  url?: string;
  title?: string;
  files?: PickedFile[];
  /** Opened by a `share?` link, which anything can write: words only, marked as such. */
  fromLink?: boolean;
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

/**
 * What the share extension handed over, between the bridge and the screen.
 * Only `ShareIntentBridge` writes here; a link can name a key but can't
 * put anything under one. One share at a time: a new one replaces the last.
 */
const stash = new Map<string, SharedPayload>();

const randomKey = () =>
  Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0')
  ).join('');

/** Keep a share-sheet payload for the screen; the key goes in the route. */
export function stashShare(s: SharedPayload, key = randomKey()): string {
  stash.clear();
  const { fromLink: _link, ...payload } = s;
  stash.set(key, payload);
  return key;
}

/** The share-sheet payload under `key`, if it is still here. */
export const stashedShare = (key: string | undefined): SharedPayload | undefined =>
  key ? stash.get(key) : undefined;

/** The screen is done with it (sent on, or closed). */
export function releaseShare(key: string | undefined) {
  if (key) stash.delete(key);
}

const param = (p: Record<string, string | string[] | undefined>, k: string) => {
  const v = p[k];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * A `share?` link's params, as a payload: the words only. `files` and any
 * other param are ignored, whatever they say.
 */
export function fromLinkParams(p: Record<string, string | string[] | undefined>): SharedPayload {
  const one = (k: string) => clean(param(p, k));
  const url = one('url');
  const text = one('text');
  const title = one('title');
  const payload: SharedPayload = {
    ...(text ? { text } : {}),
    ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
    ...(title ? { title } : {}),
  };
  return isEmptyShare(payload) ? payload : { ...payload, fromLink: true };
}

/**
 * What the share screen shows for its route: the share sheet's payload when
 * the route's one-time key `k` finds one, else the link's words.
 */
export function payloadForRoute(p: Record<string, string | string[] | undefined>): SharedPayload {
  return stashedShare(param(p, 'k')) ?? fromLinkParams(p);
}

/** A link's params for a payload's words (tests and the mock's printed links). */
export function toLinkParams(s: SharedPayload): Record<string, string> {
  return {
    ...(s.text ? { text: s.text } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.title ? { title: s.title } : {}),
  };
}

export const isEmptyShare = (s: SharedPayload) => !s.text && !s.url && !s.files?.length;

/**
 * The shared words as one quoted passage for the draft: the page's title
 * and address, then any text. A quote, not draft text, so it's never mixed
 * into what you typed and is sent as a `> ` blockquote, plainly not your
 * own words.
 */
export function sharedQuote(s: SharedPayload): string {
  const link = s.url ? (s.title && s.title !== s.url ? `${s.title}\n${s.url}` : s.url) : '';
  return [link, s.text ?? ''].filter(Boolean).join('\n\n');
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
