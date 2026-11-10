/**
 * When the app dies, what you were writing doesn't. Drafts (typed and
 * dictated words, quotes, @mentions, uploaded files) are on disk within a
 * moment of each change (drafts.ts) and again the instant the app leaves the
 * foreground; unsent messages are in the outbox before the field empties
 * (session.ts `send`). This file covers the death itself:
 *
 * - **A JavaScript crash** (`installCrashHandler`): before the system's own
 *   handler ends the app, the drafts and the outbox are written out (for at
 *   most `SAVE_BEFORE_EXIT_MS`) and the error is logged on this phone
 *   (`crash-log.json`, the last `CRASH_LOG_MAX`; it goes nowhere else).
 * - **A native crash, or the system killing the app on screen**
 *   (`startCrashWatch`): a marker is on disk only while the app is in the
 *   foreground. One still there at launch means the last run ended while you
 *   were using it, not after you left it. Not in development, where every
 *   reload would look like one.
 *
 * Either way the next launch says so once, in plain words (`takeExitNotice`).
 */

import { AppState } from 'react-native';
import { flushCache } from './cache';
import { flushDrafts } from './drafts';
import { readJson, removeJson, writeJson } from './persist';

export const CRASH_LOG = 'crash-log.json';
const LAST_CRASH = 'crash-last.json';
const LIVE = 'foreground.json';
export const CRASH_LOG_MAX = 20;
/** How long a crash may wait for the drafts to reach the disk before the app ends. */
export const SAVE_BEFORE_EXIT_MS = 1500;
export const EXIT_NOTICE = 'The app closed unexpectedly. Your draft is safe.';

export interface CrashRecord {
  at: number;
  /** `js`: an uncaught error; `render`: a screen that failed to draw (the app stayed open). */
  where: 'js' | 'render';
  fatal: boolean;
  message: string;
  stack?: string;
}

const describe = (error: unknown) => {
  const e = error as { message?: unknown; stack?: unknown } | null;
  return {
    message: String(e?.message ?? error).slice(0, 2000),
    stack: typeof e?.stack === 'string' ? e.stack.slice(0, 8000) : undefined,
  };
};

/** Log an error on this phone, and remember a fatal one for the next launch. */
export async function recordCrash(
  error: unknown,
  where: CrashRecord['where'],
  fatal: boolean,
  now = Date.now()
): Promise<void> {
  const record: CrashRecord = { at: now, where, fatal, ...describe(error) };
  const log = (await readJson<CrashRecord[]>(CRASH_LOG)) ?? [];
  await writeJson(CRASH_LOG, [...log, record].slice(-CRASH_LOG_MAX));
  if (fatal) await writeJson(LAST_CRASH, record);
}

/** What's in this phone's crash log, oldest first. */
export const crashLog = async () => (await readJson<CrashRecord[]>(CRASH_LOG)) ?? [];

type Handler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsShape {
  getGlobalHandler(): Handler;
  setGlobalHandler(h: Handler): void;
}

let installed = false;

/** Save and log before an uncaught error ends the app. Once per process. */
export function installCrashHandler(
  utils: ErrorUtilsShape | undefined = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils
): void {
  if (installed || !utils) return;
  installed = true;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    if (!isFatal) {
      void recordCrash(error, 'js', false).catch(() => {});
      previous(error, isFatal);
      return;
    }
    const save = Promise.all([flushDrafts(), flushCache(), recordCrash(error, 'js', true)]).catch(
      () => {}
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise((done) => (timer = setTimeout(done, SAVE_BEFORE_EXIT_MS)));
    void Promise.race([save, limit]).then(() => {
      clearTimeout(timer);
      previous(error, isFatal);
    });
  });
}

let watching: Promise<boolean> | null = null;

/**
 * Read how the last run ended, then keep the foreground marker from here on.
 * Resolves true when it ended in a crash. Once per process.
 */
export function startCrashWatch(dev: boolean = __DEV__): Promise<boolean> {
  watching ??= (async () => {
    const [last, live] = await Promise.all([
      readJson<CrashRecord>(LAST_CRASH),
      dev ? Promise.resolve(null) : readJson<{ at: number }>(LIVE),
    ]);
    await removeJson(LAST_CRASH).catch(() => {});
    if (!dev) {
      const mark = (s: string | null | undefined) =>
        (s === 'active' ? writeJson(LIVE, { at: Date.now() }) : removeJson(LIVE)).catch(() => {});
      void mark(AppState.currentState);
      AppState.addEventListener('change', (s) => void mark(s));
    }
    return !!last || !!live;
  })().catch(() => false);
  return watching;
}

let told = false;

/** The line to show once after a crash, or null. */
export async function takeExitNotice(): Promise<string | null> {
  const crashed = await (watching ?? startCrashWatch());
  if (!crashed || told) return null;
  told = true;
  return EXIT_NOTICE;
}
