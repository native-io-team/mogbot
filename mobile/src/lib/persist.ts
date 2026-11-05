/**
 * Small JSON files: the offline cache, the outbox, drafts and preferences.
 * Each write goes to a temporary file first and is then moved over the old
 * one, so a crash mid-write leaves the last good copy rather than half of one.
 *
 * They live in the caches folder (iOS `Library/Caches`, Android's cache
 * dir), which neither iCloud/iTunes backups nor Android Auto Backup copy:
 * chat history and drafts are this phone's, not a backup's. expo-file-system
 * 58 has no way to set `NSURLIsExcludedFromBackupKey` on a file in the
 * documents folder, so this is the folder that keeps them out. The cost: the
 * OS may clear it when the phone is very short of space. Everything but the
 * outbox and drafts comes back from the Mac on the next connect; the token
 * is in the keychain, not here.
 */

import * as FileSystem from 'expo-file-system/legacy';

const DIR = `${FileSystem.cacheDirectory ?? ''}companion-state/`;
/** Where these lived before: backed up. Moved out of on first use. */
const OLD_DIR = `${FileSystem.documentDirectory ?? ''}companion-state/`;

let moved: Promise<void> | null = null;

/**
 * Move anything an earlier version wrote in the documents folder (which is
 * backed up) to the caches folder, once, then delete the old folder.
 */
export function moveOutOfBackups(): Promise<void> {
  moved ??= (async () => {
    if (!FileSystem.documentDirectory || !FileSystem.cacheDirectory) return;
    const old = await FileSystem.getInfoAsync(OLD_DIR).catch(() => null);
    if (!old?.exists) return;
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    const names = await FileSystem.readDirectoryAsync(OLD_DIR).catch(() => [] as string[]);
    for (const name of names) {
      const there = await FileSystem.getInfoAsync(`${DIR}${name}`).catch(() => null);
      if (!there?.exists) {
        await FileSystem.moveAsync({ from: `${OLD_DIR}${name}`, to: `${DIR}${name}` }).catch(
          () => {}
        );
      }
    }
    await FileSystem.deleteAsync(OLD_DIR, { idempotent: true }).catch(() => {});
  })();
  return moved;
}

export async function readJson<T>(name: string): Promise<T | null> {
  await moveOutOfBackups();
  try {
    const raw = await FileSystem.readAsStringAsync(`${DIR}${name}`);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  await moveOutOfBackups();
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const tmp = `${DIR}${name}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(value));
  await FileSystem.moveAsync({ from: tmp, to: `${DIR}${name}` });
}

export const removeJson = (name: string) =>
  FileSystem.deleteAsync(`${DIR}${name}`, { idempotent: true });

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
