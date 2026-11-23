/** This phone's own settings (not the Mac's): kept on disk, read at launch. */

import { readJson, writeJson } from './persist';
import { defaultPrefs, getApp, setApp, type Prefs } from './store';
import { TEXT_SIZES } from './theme';

const FILE = 'prefs.json';

/** What was saved, over the defaults; a value this build doesn't know falls back to its default. */
export function readPrefs(saved: Partial<Prefs> | null | undefined): Prefs {
  const prefs = { ...defaultPrefs, ...saved };
  if (!Object.hasOwn(TEXT_SIZES, prefs.textSize)) prefs.textSize = defaultPrefs.textSize;
  prefs.folded = Array.isArray(prefs.folded)
    ? prefs.folded.filter((k): k is string => typeof k === 'string')
    : defaultPrefs.folded;
  return prefs;
}

/** Fold a section of the agents list, or open it again. */
export function toggleFolded(key: string) {
  const folded = getApp().prefs.folded;
  setPref('folded', folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key]);
}

export async function loadPrefs() {
  const saved = await readJson<Partial<Prefs>>(FILE);
  if (saved) setApp({ prefs: readPrefs(saved) });
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  const prefs = { ...getApp().prefs, [key]: value };
  setApp({ prefs });
  void writeJson(FILE, prefs).catch(() => {});
}
