/** `localStorage`, or nothing when the browser refuses it. Web QA only. */
export const local = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      /* private window: nothing kept */
    }
  },
  remove(key: string) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* nothing to remove */
    }
  },
  keys(): string[] {
    try {
      const s = globalThis.localStorage;
      return s ? Array.from({ length: s.length }, (_, i) => s.key(i) ?? '') : [];
    } catch {
      return [];
    }
  },
};
