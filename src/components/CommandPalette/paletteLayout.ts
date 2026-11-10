/**
 * What the ⌘K palette shows for a query, a tab and a place in the app: the
 * tabs, the groups in order, and one flat list that arrow keys walk. Pure, so
 * the rules below are tested without rendering the palette.
 *
 * - **Agents first.** On the desk the Agents group leads; inside a project the
 *   project's own actions do, and Agents follows them.
 * - **The best match leads.** With a query, groups are ordered by their best
 *   row, so the first row (the one Enter runs) is the best match overall, not
 *   the best match in whichever group happens to be listed first.
 * - **Recent** (nothing typed): the few commands run most and most lately,
 *   shown once, above everything, and not again in their own group.
 * - **Nothing matches**: the fallbacks (ask the Chief of Staff) become the
 *   list, handed what was typed; on a tab with no results the line says how
 *   many there are under All.
 *
 * @module components/CommandPalette/paletteLayout
 */

import { paletteGroup, type Command, type PaletteGroup } from '../../commands/types';
import type { RankedCommand } from '../../commands/useRankedCommands';
import type { PaletteContextKind } from './paletteContext';

export type TabId = 'all' | PaletteGroup;

export interface PaletteTab {
  id: TabId;
  label: string;
}

/** One row: an ordinary result, or a fallback handed the query. */
export interface PaletteRow {
  cmd: Command;
  /** Index in the flat list, which is what the arrow keys and Enter use. */
  index: number;
  /** For a fallback: the text it will be handed. */
  query?: string;
}

export interface PaletteSection {
  group: PaletteGroup | 'fallback';
  /** No label for the fallback section: the empty line above it says it. */
  label: string | null;
  rows: PaletteRow[];
}

export interface PaletteLayout {
  sections: PaletteSection[];
  rows: PaletteRow[];
  /** What to say when the list has no ordinary results; null when it has some. */
  empty: null | { kind: 'nothing' } | { kind: 'no-match'; query: string; elsewhere: number };
}

const HOME_TABS: PaletteTab[] = [
  { id: 'all', label: 'All' },
  { id: 'agents', label: 'Agents' },
  { id: 'project', label: 'Projects' },
  { id: 'action', label: 'Actions' },
  { id: 'settings', label: 'Settings' },
];

const PROJECT_TABS: PaletteTab[] = [
  { id: 'all', label: 'All' },
  { id: 'action', label: 'Actions' },
  { id: 'branch', label: 'Branches' },
  { id: 'agents', label: 'Agents' },
  { id: 'project', label: 'Projects' },
  { id: 'settings', label: 'Settings' },
];

export function tabsFor(context: PaletteContextKind): PaletteTab[] {
  return context === 'project' ? PROJECT_TABS : HOME_TABS;
}

const HOME_ORDER: PaletteGroup[] = [
  'recent',
  'agents',
  'navigation',
  'project',
  'action',
  'branch',
  'extension',
  'settings',
];

const PROJECT_ORDER: PaletteGroup[] = [
  'recent',
  'action',
  'branch',
  'extension',
  'agents',
  'project',
  'navigation',
  'settings',
];

export const GROUP_LABEL: Record<PaletteGroup, string> = {
  recent: 'Recent',
  agents: 'Agents',
  navigation: 'Go to',
  project: 'Projects',
  action: 'Actions',
  branch: 'Branches',
  extension: 'Skills & MCP',
  settings: 'Settings',
};

/** How many recently run commands lead the list when nothing is typed. */
export const RECENT_LIMIT = 4;

export function layoutPalette({
  ranked,
  fallbacks,
  tab,
  context,
  query,
}: {
  ranked: RankedCommand[];
  fallbacks: Command[];
  tab: TabId;
  context: PaletteContextKind;
  query: string;
}): PaletteLayout {
  const q = query.trim();
  const inTab = tab === 'all' ? ranked : ranked.filter((c) => paletteGroup(c) === tab);

  if (inTab.length === 0) {
    if (!q) return { sections: [], rows: [], empty: { kind: 'nothing' } };
    // The fallbacks are offered only when nothing anywhere matched: on a tab
    // with results elsewhere, the way on is All, not the Chief.
    const elsewhere = tab === 'all' ? 0 : ranked.length;
    const rows: PaletteRow[] =
      elsewhere > 0 ? [] : fallbacks.map((cmd, index) => ({ cmd, index, query: q }));
    return {
      sections: rows.length ? [{ group: 'fallback', label: null, rows }] : [],
      rows,
      empty: { kind: 'no-match', query: q, elsewhere },
    };
  }

  const buckets = new Map<PaletteGroup, RankedCommand[]>();
  const put = (group: PaletteGroup, cmd: RankedCommand) => {
    const list = buckets.get(group);
    if (list) list.push(cmd);
    else buckets.set(group, [cmd]);
  };

  // Recent only on All with nothing typed: a query has its own best match.
  const recent = new Set<string>();
  if (tab === 'all' && !q) {
    for (const cmd of inTab) {
      if (recent.size >= RECENT_LIMIT || cmd._frecency <= 0) break;
      recent.add(cmd.id);
      put('recent', cmd);
    }
  }
  for (const cmd of inTab) {
    if (!recent.has(cmd.id)) put(paletteGroup(cmd), cmd);
  }

  const fixed = context === 'project' ? PROJECT_ORDER : HOME_ORDER;
  let order = fixed.filter((g) => buckets.has(g));
  if (q) {
    // `ranked` is best-first, so each bucket's first row is its best.
    const best = (g: PaletteGroup) => buckets.get(g)![0]._score;
    order = [...order].sort((a, b) => best(b) - best(a));
  }

  const rows: PaletteRow[] = [];
  const sections = order.map((group) => {
    const sectionRows = buckets.get(group)!.map((cmd) => {
      const row = { cmd, index: rows.length };
      rows.push(row);
      return row;
    });
    // A single tab is one group already; its header would only repeat the tab.
    return { group, label: tab === 'all' ? GROUP_LABEL[group] : null, rows: sectionRows };
  });
  return { sections, rows, empty: null };
}
