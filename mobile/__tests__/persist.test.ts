/**
 * Where the phone keeps its files: the chat history copy in caches (the OS
 * may clear it; the Mac has it all), and what only this phone has (the
 * outbox, drafts, preferences) where the OS never clears it. Files an
 * earlier version left elsewhere move once, and never by deleting first.
 */

const mockFiles = new Map<string, string>();
/** Copies to these destinations fail, as a full disk would. */
const mockFailCopyTo = new Set<string>();

jest.mock('expo-file-system/legacy', () => {
  const dirOf = (p: string) => p.replace(/[^/]+$/, '');
  return {
    documentDirectory: 'file:///App/Documents/',
    cacheDirectory: 'file:///App/Library/Caches/',
    getInfoAsync: (p: string) =>
      Promise.resolve({
        exists: mockFiles.has(p) || [...mockFiles.keys()].some((k) => k.startsWith(p)),
      }),
    readDirectoryAsync: (p: string) =>
      Promise.resolve(
        [...mockFiles.keys()].filter((k) => dirOf(k) === p).map((k) => k.slice(p.length))
      ),
    makeDirectoryAsync: () => Promise.resolve(),
    readAsStringAsync: (p: string) =>
      mockFiles.has(p) ? Promise.resolve(mockFiles.get(p)!) : Promise.reject(new Error('missing')),
    writeAsStringAsync: (p: string, v: string) => {
      mockFiles.set(p, v);
      return Promise.resolve();
    },
    copyAsync: ({ from, to }: { from: string; to: string }) => {
      if (mockFailCopyTo.has(to)) {
        // Half a file, then the failure.
        mockFiles.set(to, mockFiles.get(from)!.slice(0, 2));
        return Promise.reject(new Error('disk full'));
      }
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
  };
});

const CACHES = 'file:///App/Library/Caches/companion-state/';
const KEEP = 'file:///App/Library/Application%20Support/companion-state/';
const OLD = 'file:///App/Documents/companion-state/';

beforeEach(() => {
  mockFiles.clear();
  mockFailCopyTo.clear();
  jest.resetModules();
});

/** A fresh copy of the module: a new launch. */
const load = () =>
  Promise.resolve(jest.requireActual<typeof import('../src/lib/persist')>('../src/lib/persist'));

it('keeps the history copy in caches and what only the phone has in Application Support', async () => {
  const { writeJson, readJson, KEEP_DIR, CACHE_DIR } = await load();
  expect(KEEP_DIR).toBe(KEEP);
  expect(CACHE_DIR).toBe(CACHES);
  await writeJson('cache-srv_1.json', { chats: 1 });
  await writeJson('outbox-srv_1.json', { pending: 1 });
  await writeJson('drafts-srv_1.json', { d: 1 });
  await writeJson('prefs.json', { p: 1 });
  expect(mockFiles.has(`${CACHES}cache-srv_1.json`)).toBe(true);
  for (const name of ['outbox-srv_1.json', 'drafts-srv_1.json', 'prefs.json']) {
    expect(mockFiles.has(`${KEEP}${name}`)).toBe(true);
  }
  expect(await readJson('outbox-srv_1.json')).toEqual({ pending: 1 });
});

it('moves what earlier versions left, each file to its place, and empties the old folder', async () => {
  mockFiles.set(`${OLD}cache-srv_1.json`, '{"old":true}');
  mockFiles.set(`${OLD}drafts-srv_1.json`, '{"d":1}');
  // The version before this one kept drafts in caches.
  mockFiles.set(`${CACHES}prefs.json`, '{"p":1}');
  const { readJson } = await load();
  expect(await readJson('cache-srv_1.json')).toEqual({ old: true });
  expect(mockFiles.get(`${KEEP}drafts-srv_1.json`)).toBe('{"d":1}');
  expect(mockFiles.get(`${KEEP}prefs.json`)).toBe('{"p":1}');
  expect(mockFiles.has(`${CACHES}prefs.json`)).toBe(false);
  expect([...mockFiles.keys()].some((k) => k.startsWith(OLD))).toBe(false);
});

it('never deletes a file that didn’t copy, and tries again next launch', async () => {
  mockFiles.set(`${OLD}drafts-srv_1.json`, '{"draft":"half a message"}');
  mockFiles.set(`${OLD}cache-srv_1.json`, '{"c":1}');
  mockFailCopyTo.add(`${KEEP}drafts-srv_1.json`);
  await (await load()).settle();
  // The draft stayed where it was, the broken copy is gone, the folder stays.
  expect(mockFiles.get(`${OLD}drafts-srv_1.json`)).toBe('{"draft":"half a message"}');
  expect(mockFiles.has(`${KEEP}drafts-srv_1.json`)).toBe(false);
  // The file that did copy moved.
  expect(mockFiles.get(`${CACHES}cache-srv_1.json`)).toBe('{"c":1}');
  expect(mockFiles.has(`${OLD}cache-srv_1.json`)).toBe(false);

  // Next launch, the disk has room.
  mockFailCopyTo.clear();
  jest.resetModules();
  const { readJson } = await load();
  expect(await readJson('drafts-srv_1.json')).toEqual({ draft: 'half a message' });
  expect([...mockFiles.keys()].some((k) => k.startsWith(OLD))).toBe(false);
});

it('leaves an old file alone when a different newer one is already in place', async () => {
  mockFiles.set(`${OLD}drafts-srv_1.json`, '{"d":"old"}');
  mockFiles.set(`${KEEP}drafts-srv_1.json`, '{"d":"new"}');
  const { readJson } = await load();
  expect(await readJson('drafts-srv_1.json')).toEqual({ d: 'new' });
  expect(mockFiles.get(`${OLD}drafts-srv_1.json`)).toBe('{"d":"old"}');
});
