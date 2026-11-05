/**
 * The offline cache, outbox and drafts stay out of backups: they live in the
 * caches folder, and anything an earlier version left in the (backed up)
 * documents folder is moved out of it.
 */

const mockFiles = new Map<string, string>();

jest.mock('expo-file-system/legacy', () => {
  const dirOf = (p: string) => p.replace(/[^/]+$/, '');
  return {
    documentDirectory: 'file:///Documents/',
    cacheDirectory: 'file:///Library/Caches/',
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

import { readJson, writeJson } from '../src/lib/persist';

it('keeps state in the caches folder and moves an old copy out of the backed-up one', async () => {
  mockFiles.set('file:///Documents/companion-state/cache-srv_1.json', '{"old":true}');
  mockFiles.set('file:///Documents/companion-state/drafts.json', '{"d":1}');
  expect(await readJson('cache-srv_1.json')).toEqual({ old: true });
  expect([...mockFiles.keys()].some((k) => k.startsWith('file:///Documents/'))).toBe(false);
  expect(mockFiles.get('file:///Library/Caches/companion-state/drafts.json')).toBe('{"d":1}');

  await writeJson('outbox.json', { n: 1 });
  expect(mockFiles.has('file:///Library/Caches/companion-state/outbox.json')).toBe(true);
  expect([...mockFiles.keys()].some((k) => k.startsWith('file:///Documents/'))).toBe(false);
});
