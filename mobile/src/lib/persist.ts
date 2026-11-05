/**
 * Small JSON files: the offline cache, the outbox, drafts and preferences.
 * Each write goes to a temporary file first and is then moved over the old
 * one, so a crash mid-write leaves the last good copy rather than half of one.
 *
 * Two places, by what losing the file would cost:
 *
 * - The chat history copy (`cache-*.json`) is in the caches folder (iOS
 *   `Library/Caches`, Android's cache dir). The OS may clear it when the
 *   phone is short of space, which costs nothing: it comes back from the Mac
 *   on the next connect. Backups don't copy it.
 * - What only this phone has, unsent messages (`outbox-*.json`), drafts and
 *   preferences, is kept where the OS never clears it: iOS
 *   `Library/Application Support`, Android's files dir. Both are included in
 *   device backups (expo-file-system can't mark a file excluded); these are
 *   a few kilobytes of the user's own words, never a token (that's in the
 *   keychain) or a secret (those are never written anywhere).
 *
 * Earlier versions kept everything in the documents folder, then everything
 * in caches. `settle()` moves each file to its place once, copying and
 * checking the copy before the original goes: a file that didn't copy stays
 * where it was, to be tried again next launch.
 */

import * as FileSystem from 'expo-file-system/legacy';

const CACHES = FileSystem.cacheDirectory ?? '';
const DOCUMENTS = FileSystem.documentDirectory ?? '';

/** Where the chat history copy lives: may be cleared by the OS. */
export const CACHE_DIR = `${CACHES}companion-state/`;

/**
 * Where what only this phone has lives. iOS's Application Support sits
 * beside Caches in the app's Library (expo-file-system allows it but has no
 * constant for it); anywhere else, the files dir under its own folder.
 */
export const KEEP_DIR = /\/Library\/Caches\/$/.test(CACHES)
  ? `${CACHES.replace(/Caches\/$/, 'Application%20Support/')}companion-state/`
  : `${DOCUMENTS}companion-keep/`;

/** Where every version before kept them all. */
const OLD_DIR = `${DOCUMENTS}companion-state/`;

/** Which folder a file belongs in. */
export const dirFor = (name: string) => (name.startsWith('cache-') ? CACHE_DIR : KEEP_DIR);

const exists = (path: string) =>
  FileSystem.getInfoAsync(path)
    .then((i) => i.exists)
    .catch(() => false);
const read = (path: string) => FileSystem.readAsStringAsync(path).catch(() => null);

/**
 * Move one file to `to`, never losing it: copy, read the copy back, and
 * only when it matches delete the original. A copy that doesn't match is
 * removed and the original stays. If `to` is already there (a newer file
 * this version wrote), the original is removed only when it says the same.
 */
async function moveSafely(from: string, to: string): Promise<void> {
  const original = await read(from);
  if (original === null) return;
  if (await exists(to)) {
    if ((await read(to)) === original) await FileSystem.deleteAsync(from, { idempotent: true });
    return;
  }
  try {
    await FileSystem.copyAsync({ from, to });
  } catch {
    // Whatever part of a copy got written isn't the file.
    await FileSystem.deleteAsync(to, { idempotent: true }).catch(() => {});
    return;
  }
  if ((await read(to)) === original) {
    await FileSystem.deleteAsync(from, { idempotent: true }).catch(() => {});
  } else {
    await FileSystem.deleteAsync(to, { idempotent: true }).catch(() => {});
  }
}

let settled: Promise<void> | null = null;

/** Put every file an earlier version wrote where it belongs now, once per launch. */
export function settle(): Promise<void> {
  settled ??= (async () => {
    if (!CACHES || !DOCUMENTS) return;
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true }).catch(() => {});
    await FileSystem.makeDirectoryAsync(KEEP_DIR, { intermediates: true }).catch(() => {});
    for (const dir of [OLD_DIR, CACHE_DIR]) {
      if (!(await exists(dir))) continue;
      const names = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
      for (const name of names) {
        // A temporary file is half a write: never the copy to keep.
        if (name.endsWith('.tmp') || dirFor(name) === dir) continue;
        await moveSafely(`${dir}${name}`, `${dirFor(name)}${name}`);
      }
    }
    // The old folder goes only once nothing is left in it.
    const left = await FileSystem.readDirectoryAsync(OLD_DIR).catch(() => null);
    if (left && left.every((n) => n.endsWith('.tmp'))) {
      await FileSystem.deleteAsync(OLD_DIR, { idempotent: true }).catch(() => {});
    }
  })();
  return settled;
}

export async function readJson<T>(name: string): Promise<T | null> {
  await settle();
  try {
    const raw = await FileSystem.readAsStringAsync(`${dirFor(name)}${name}`);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  await settle();
  const dir = dirFor(name);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const tmp = `${dir}${name}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(value));
  await FileSystem.moveAsync({ from: tmp, to: `${dir}${name}` });
}

export const removeJson = (name: string) =>
  FileSystem.deleteAsync(`${dirFor(name)}${name}`, { idempotent: true });

/**
 * `write` at most once per `ms`, always with the latest value, and once more
 * on `flush()` (the app going to the background, where it may be killed).
 */
export function debounced(write: () => Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    timer = null;
    running = running.then(write).catch(() => {});
    return running;
  };
  return {
    schedule() {
      if (!timer) timer = setTimeout(() => void run(), ms);
    },
    flush() {
      if (timer) clearTimeout(timer);
      return run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
