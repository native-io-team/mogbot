/**
 * The icon pack's loaders under Jest (mapped in package.json's jest config):
 * the real ones are `import()`, which Metro bundles and Jest can't run
 * without its experimental ESM flag. The same files, required on demand.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- a file required by name, on demand, is the point */

const DIR = '../../packages/companion-protocol/src/agent-key-pack';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

const load = (file: string): Promise<unknown> => {
  try {
    return Promise.resolve(require(`${DIR}/${file}`) as unknown);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
};

const exists = (file: string) => {
  try {
    require.resolve(`${DIR}/${file}`);
    return true;
  } catch {
    return false;
  }
};

export const PACK_SHARDS: Record<string, () => Promise<unknown>> = Object.fromEntries(
  [...LETTERS]
    .filter((s) => exists(`drawings-${s}.json`))
    .map((s) => [s, () => load(`drawings-${s}.json`)])
);

export const PACK_INDEX = (): Promise<unknown> => load('index.json');
