/**
 * Images placed in the words, as a terminal does it: a pasted, dropped or
 * picked image goes in as `[Image 1]` where the caret is, and the sent message
 * shows the picture at that place rather than in the row above the text.
 *
 * Image N is always the message's Nth image attachment (by `isImageMime`, in
 * the order attached), so nothing new is stored: the marker in the words and
 * the order of the files say it all. The Mac labels the files the same way in
 * what the agent is told (`attachments::prompt_block`).
 *
 * @module lib/inlineImages
 */

import { isImageMime } from './agents';

export const imageMarker = (n: number) => `[Image ${n}]`;

const MARKER = /\[Image (\d+)\]/g;

/** The numbers of the markers in `text`. */
export function markerNumbers(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.matchAll(MARKER)) found.add(Number(match[1]));
  return found;
}

/** The images among `files`, in order: image N is `imagesIn(files)[N - 1]`. */
export function imagesIn<T extends { mime: string }>(files: readonly T[]): T[] {
  return files.filter((f) => isImageMime(f.mime));
}

/**
 * `numbers`' markers put in at the selection, replacing it, with a space
 * either side where a word would touch them, and the caret after them.
 */
export function insertMarkers(
  value: string,
  start: number,
  end: number,
  numbers: readonly number[]
): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const before = value.slice(0, from);
  const after = value.slice(to);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  // A space after, so the next word typed doesn't touch it.
  const trail = /^\s/.test(after) ? '' : ' ';
  const inserted = `${lead}${numbers.map(imageMarker).join(' ')}${trail}`;
  return { value: before + inserted + after, caret: before.length + inserted.length };
}

/**
 * The words once images `removed` (numbers out of `count`) are gone: their
 * markers taken out with a space beside them, and the markers after them
 * numbered down so image N is still the Nth image. A marker past `count` is
 * just words someone typed, and stays as it is. `caret` moves with the text.
 */
export function withoutImages(
  text: string,
  removed: readonly number[],
  count: number,
  caret = text.length
): { text: string; caret: number } {
  if (removed.length === 0) return { text, caret };
  const gone = new Set(removed);
  const edits: { start: number; end: number; insert: string }[] = [];
  for (const match of text.matchAll(MARKER)) {
    const n = Number(match[1]);
    const start = match.index ?? 0;
    let end = start + match[0].length;
    if (n < 1 || n > count) continue;
    if (gone.has(n)) {
      // Take one space with it, so no double space or stray edge is left.
      if (text[end] === ' ') end += 1;
      else if (start > 0 && text[start - 1] === ' ') {
        edits.push({ start: start - 1, end, insert: '' });
        continue;
      }
      edits.push({ start, end, insert: '' });
      continue;
    }
    const lower = removed.filter((r) => r < n).length;
    if (lower > 0) edits.push({ start, end, insert: imageMarker(n - lower) });
  }
  let out = '';
  let at = 0;
  let moved = caret;
  for (const edit of edits) {
    out += text.slice(at, edit.start) + edit.insert;
    at = edit.end;
    const delta = edit.insert.length - (edit.end - edit.start);
    if (caret >= edit.end) moved += delta;
    // Inside what was taken out: just after where it was.
    else if (caret > edit.start) moved = out.length;
  }
  out += text.slice(at);
  return { text: out, caret: Math.max(0, Math.min(moved, out.length)) };
}

/** Which of `count` images had a marker in `before` and has none in `after`. */
export function markersLost(before: string, after: string, count: number): number[] {
  const had = markerNumbers(before);
  const has = markerNumbers(after);
  const lost: number[] = [];
  for (let n = 1; n <= count; n++) if (had.has(n) && !has.has(n)) lost.push(n);
  return lost;
}

/**
 * Backspace just after a marker, or Delete just before one, takes the whole
 * marker (and so its image), as a terminal does: never half a marker left
 * behind. Null when the key isn't against a marker.
 */
export function markerAtCaret(
  text: string,
  caret: number,
  key: 'Backspace' | 'Delete',
  count: number
): number | null {
  for (const match of text.matchAll(MARKER)) {
    const n = Number(match[1]);
    if (n < 1 || n > count) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (key === 'Backspace' && end === caret) return n;
    if (key === 'Delete' && start === caret) return n;
  }
  return null;
}

export type Segment = { kind: 'text'; text: string } | { kind: 'image'; n: number };

/**
 * Words and images in the order they were written, for a message with
 * `count` images. Each image sits on a line of its own, so the spaces and
 * line breaks either side of it are dropped. A marker past `count` (or one
 * repeated) is left as words.
 */
export function splitAtImages(text: string, count: number): Segment[] {
  const segments: Segment[] = [];
  const placed = new Set<number>();
  const words = (part: string) => {
    // Against an image, an edge's spaces and line breaks go.
    const afterImage = segments[segments.length - 1]?.kind === 'image';
    return afterImage ? part.trimStart() : part;
  };
  let at = 0;
  for (const match of text.matchAll(MARKER)) {
    const n = Number(match[1]);
    const start = match.index ?? 0;
    if (n < 1 || n > count || placed.has(n)) continue;
    const before = words(text.slice(at, start)).trimEnd();
    if (before) segments.push({ kind: 'text', text: before });
    segments.push({ kind: 'image', n });
    placed.add(n);
    at = start + match[0].length;
  }
  const rest = words(text.slice(at));
  if (rest.trim()) segments.push({ kind: 'text', text: rest });
  return segments;
}

/** The numbers of the images `text` places among its words. */
export function placedImages(text: string, count: number): Set<number> {
  const placed = new Set<number>();
  for (const segment of splitAtImages(text, count)) {
    if (segment.kind === 'image') placed.add(segment.n);
  }
  return placed;
}

/** `files` less the images `placed` among the words: what the row above them still shows. */
export function notPlaced<T extends { mime: string }>(
  files: readonly T[],
  placed: Set<number>
): T[] {
  if (placed.size === 0) return [...files];
  let n = 0;
  return files.filter((f) => !(isImageMime(f.mime) && placed.has(++n)));
}
