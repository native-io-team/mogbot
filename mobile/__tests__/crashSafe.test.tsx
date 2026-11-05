/* eslint-disable @typescript-eslint/no-require-imports -- each launch requires fresh modules */
/**
 * Nothing you were writing is lost when the app dies: the draft (typed and
 * dictated words alike) is on disk within DRAFT_SAVE_MS of each change and
 * comes back on the next launch, saying so once; a send in flight when it
 * died comes back waiting, with the same clientId, so it goes once; a crash
 * saves before the app ends and the next launch says so plainly.
 *
 * "Killing" the app is `jest.resetModules()`: a fresh store and fresh
 * modules over the same files, which is what a relaunch is.
 */

import { act, renderHook } from '@testing-library/react-native';
import * as firstDrafts from '../src/lib/drafts';
import * as firstStore from '../src/lib/store';
import * as firstDictation from '../src/lib/dictation';

const mockFiles = new Map<string, string>();

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///App/Documents/',
  cacheDirectory: 'file:///App/Library/Caches/',
  getInfoAsync: (p: string) =>
    Promise.resolve({ exists: [...mockFiles.keys()].some((k) => k.startsWith(p)) }),
  readDirectoryAsync: () => Promise.resolve([]),
  makeDirectoryAsync: () => Promise.resolve(),
  readAsStringAsync: (p: string) =>
    mockFiles.has(p) ? Promise.resolve(mockFiles.get(p)!) : Promise.reject(new Error('missing')),
  writeAsStringAsync: (p: string, v: string) => {
    mockFiles.set(p, v);
    return Promise.resolve();
  },
  copyAsync: ({ from, to }: { from: string; to: string }) => {
    mockFiles.set(to, mockFiles.get(from)!);
    return Promise.resolve();
  },
  moveAsync: ({ from, to }: { from: string; to: string }) => {
    mockFiles.set(to, mockFiles.get(from)!);
    mockFiles.delete(from);
    return Promise.resolve();
  },
  deleteAsync: (p: string) => {
    for (const k of [...mockFiles.keys()]) if (k.startsWith(p)) mockFiles.delete(k);
    return Promise.resolve();
  },
}));

type Drafts = typeof import('../src/lib/drafts');
type Store = typeof import('../src/lib/store');
type Cache = typeof import('../src/lib/cache');
type Crash = typeof import('../src/lib/crash');
type Dictation = typeof import('../src/lib/dictation');

/** A launch: fresh modules, paired to the same (fictional) Mac. */
function launch() {
  jest.resetModules();
  const store = require('../src/lib/store') as Store;
  store.setApp({ credentials: { serverId: 'mac-fixture' } as never });
  return {
    store,
    drafts: require('../src/lib/drafts') as Drafts,
    cache: require('../src/lib/cache') as Cache,
    crash: require('../src/lib/crash') as Crash,
    dictation: require('../src/lib/dictation') as Dictation,
    rn: require('react-native') as typeof import('react-native'),
  };
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function fakeRecognizer() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const fire = (name: string, e: unknown = null) => listeners.get(name)?.forEach((l) => l(e));
  return {
    supportsOnDeviceRecognition: () => true,
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: () => Promise.resolve({ granted: true }),
    start: () => fire('start'),
    stop: () => fire('end'),
    abort: () => fire('end'),
    addListener: (name: string, l: (e: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(l);
      return { remove: () => listeners.get(name)!.delete(l) };
    },
    fire,
  };
}

beforeEach(() => mockFiles.clear());

describe('a draft', () => {
  it('survives the app being killed mid-dictation, and says it was restored, once', async () => {
    // The modules this test file loaded: the React the renderer uses.
    const first = { drafts: firstDrafts, store: firstStore, dictation: firstDictation };
    first.store.setApp({ credentials: { serverId: 'mac-fixture' } as never });
    const { setComposer } = first.drafts;
    first.store.setApp({ composer: { chief: { text: 'Typed first', quotes: [], mentions: [] } } });
    const r = fakeRecognizer();

    const hook = await renderHook(() =>
      first.dictation.useDictation({
        getDraft: () => first.store.getApp().composer.chief?.text ?? '',
        setDraft: (text) => setComposer('chief', { text }),
        vocabulary: [],
        recognizer: r as never,
      })
    );
    await act(async () => {
      await hook.result.current.start();
    });
    await act(() =>
      r.fire('result', { isFinal: false, results: [{ transcript: 'and then said' }] })
    );
    // Still listening, nothing stopped, nothing flushed: just the save's beat.
    expect(hook.result.current.phase).toBe('listening');
    await act(() => wait(first.drafts.DRAFT_SAVE_MS + 50));

    // Killed. Nothing ran on the way out.
    const next = launch();
    expect(next.store.getApp().composer.chief).toBeUndefined();
    await next.drafts.loadDrafts('mac-fixture');
    expect(next.store.getApp().composer.chief?.text).toBe('Typed first and then said');
    expect(next.drafts.takeRestored('chief')).toBe(true);
    expect(next.drafts.takeRestored('chief')).toBe(false);
    expect(next.drafts.takeRestored('nobody')).toBe(false);
  });

  it('keeps the last moment too when the app leaves the foreground', async () => {
    const first = launch();
    first.drafts.setComposer('chief', { text: 'Half a thought' });
    // The app goes to the background (session.ts) before the beat is up.
    await first.drafts.flushDrafts();
    const next = launch();
    await next.drafts.loadDrafts('mac-fixture');
    expect(next.store.getApp().composer.chief?.text).toBe('Half a thought');
  });
});

describe('a send in flight when the app died', () => {
  it('comes back waiting with the same clientId, to go once, and never vanishes', async () => {
    const first = launch();
    // What `send` does: the message into the outbox, on disk at once, then the draft emptied.
    first.store.setApp({
      pending: {
        chief: [
          { clientId: 'c-1', agentId: 'chief', text: 'Book the venue', ts: 1000, failed: false },
        ],
      },
    });
    await first.cache.saveOutbox();
    first.drafts.clearComposer('chief');
    await first.drafts.flushDrafts();

    const next = launch();
    await next.cache.loadCache('mac-fixture');
    await next.drafts.loadDrafts('mac-fixture');
    const pending = next.store.getApp().pending.chief;
    // Not lost, and not in the composer as well (where it could be sent twice).
    expect(pending).toEqual([expect.objectContaining({ clientId: 'c-1', waiting: true })]);
    expect(next.store.getApp().composer.chief).toBeUndefined();

    const { outboxPlan, OUTBOX_WAIT_MS } =
      require('../src/lib/outbox') as typeof import('../src/lib/outbox');
    // Within the window it goes again by itself, once, with the id the Mac dedupes on.
    const soon = outboxPlan(next.store.getApp().pending, 1000 + 60_000);
    expect(soon.flush.map((p) => p.clientId)).toEqual(['c-1']);
    expect(soon.expire).toEqual([]);
    // Past it, it's "Not sent · Send" to send again by hand: still the same id.
    const late = outboxPlan(next.store.getApp().pending, 1000 + OUTBOX_WAIT_MS + 1);
    expect(late.flush).toEqual([]);
    expect(late.expire.map((p) => p.clientId)).toEqual(['c-1']);

    // The Mac confirms it: gone from the outbox, so it can't go a second time.
    const { confirmSend } = require('../src/lib/sync') as typeof import('../src/lib/sync');
    const after = confirmSend(next.store.getApp(), 'c-1', {
      id: 'm-1',
      role: 'user',
      text: 'Book the venue',
      ts: 1500,
      agentId: 'chief',
      clientId: 'c-1',
    } as never);
    expect(after.pending.chief ?? []).toEqual([]);
    expect(outboxPlan(after.pending, 2000).flush).toEqual([]);
  });
});

describe('a crash', () => {
  it('saves the drafts before the app ends, logs the error here, and says so next launch', async () => {
    const first = launch();
    first.drafts.setComposer('chief', { text: 'Do not lose this' });
    const previous = jest.fn();
    const utils = {
      handler: previous as (e: unknown, fatal?: boolean) => void,
      getGlobalHandler() {
        return this.handler;
      },
      setGlobalHandler(h: (e: unknown, fatal?: boolean) => void) {
        this.handler = h;
      },
    };
    first.crash.installCrashHandler(utils);
    utils.handler(new Error('Fixture failure'), true);
    // The system's handler (which ends the app) waits for the save.
    expect(previous).not.toHaveBeenCalled();
    await act(() => wait(50));
    expect(previous).toHaveBeenCalledTimes(1);

    const next = launch();
    await next.drafts.loadDrafts('mac-fixture');
    expect(next.store.getApp().composer.chief?.text).toBe('Do not lose this');
    await expect(next.crash.startCrashWatch(true)).resolves.toBe(true);
    await expect(next.crash.takeExitNotice()).resolves.toBe(next.crash.EXIT_NOTICE);
    await expect(next.crash.takeExitNotice()).resolves.toBeNull();
    const log = await next.crash.crashLog();
    expect(log).toEqual([
      expect.objectContaining({ where: 'js', fatal: true, message: 'Fixture failure' }),
    ]);

    // And the launch after that is a normal one.
    const third = launch();
    await expect(third.crash.startCrashWatch(true)).resolves.toBe(false);
  });

  it('counts a run that ended in the foreground, which a native crash leaves behind', async () => {
    const first = launch();
    Object.defineProperty(first.rn.AppState, 'currentState', {
      value: 'active',
      configurable: true,
    });
    // A release build marks itself while on screen.
    await expect(first.crash.startCrashWatch(false)).resolves.toBe(false);
    await act(() => wait(20));
    // Then it dies without leaving the foreground.
    const next = launch();
    await expect(next.crash.startCrashWatch(false)).resolves.toBe(true);
  });

  it('passes a non-fatal error straight on, logged', async () => {
    const { crash } = launch();
    const previous = jest.fn();
    const utils = {
      handler: previous as (e: unknown, fatal?: boolean) => void,
      getGlobalHandler() {
        return this.handler;
      },
      setGlobalHandler(h: (e: unknown, fatal?: boolean) => void) {
        this.handler = h;
      },
    };
    crash.installCrashHandler(utils);
    utils.handler(new Error('Soft'), false);
    expect(previous).toHaveBeenCalledWith(expect.any(Error), false);
    await act(() => wait(20));
    expect(await crash.crashLog()).toEqual([expect.objectContaining({ fatal: false })]);
    // Not a crash: the next launch says nothing.
    const next = launch();
    await expect(next.crash.startCrashWatch(true)).resolves.toBe(false);
  });
});
