/**
 * Rewind, fork and edit on the phone (`agents/rewind.rs`, docs/agents.md,
 * "Rewind, fork and edit"): the chat's fold of what a rewind passed over,
 * and the project a confirm names. The words are shared with the desk
 * (`@shipstudio/companion-protocol`'s `rewind.ts`).
 */

import {
  foldRewound,
  rewoundIds,
  type Agent,
  type Rewind,
} from '@shipstudio/companion-protocol';
import type { Item } from './timeline';

/** The fold's own row: collapsed, or open with its lines shown below it. */
export type RewoundItem = Extract<Item, { kind: 'rewound' }>;

/** The message ids an item stands for. A day line stands for none. */
function idsOf(item: Item): string[] {
  if (item.kind === 'message') return [item.message.id];
  if (item.kind === 'room') return [item.fold.last.id];
  return [];
}

/**
 * The chat's rows (newest first, as the list is inverted) with each run of
 * lines one rewind folded gathered under one "Rewound" row. Closed, the
 * row stands in for them; open, it sits above them (older side), and they
 * show. A day line between two folded lines of the same rewind is folded
 * with them.
 */
export function foldRewoundItems(
  items: Item[],
  rewinds: readonly Rewind[] | undefined,
  open: ReadonlySet<string>
): Item[] {
  if (!rewinds?.length) return items;
  const rewound = rewoundIds(rewinds);
  // A day line takes the rewind of the line just older than it (the next
  // item, the list being newest first) when the newer one has it too.
  const dayIds = new Map<Item, string[]>();
  items.forEach((item, i) => {
    if (item.kind !== 'day') return;
    const newer = items[i - 1];
    const older = items[i + 1];
    const a = newer ? idsOf(newer)[0] : undefined;
    const b = older ? idsOf(older)[0] : undefined;
    const by = a && rewound.get(a);
    if (by && b && rewound.get(b) === by) dayIds.set(item, [a]);
  });
  const folded = foldRewound(items, rewound, (item) => dayIds.get(item) ?? idsOf(item));
  const out: Item[] = [];
  for (const f of folded) {
    if (f.kind === 'item') {
      out.push(f.item);
      continue;
    }
    const count = f.items.reduce(
      (n, i) => n + (i.kind === 'room' ? i.fold.count : idsOf(i).length),
      0
    );
    const isOpen = open.has(f.rewindId);
    const row: RewoundItem = {
      kind: 'rewound',
      key: `rewound:${f.rewindId}:${f.items[f.items.length - 1].key}`,
      rewindId: f.rewindId,
      count,
      open: isOpen,
    };
    // Inverted: the row is drawn above its lines when it comes after them.
    if (isOpen) out.push(...f.items, row);
    else out.push(row);
  }
  return out;
}

/** The project a confirm names: only an agent working in a copy has one to discard. */
export function copyProject(agent: Pick<Agent, 'project' | 'workDirectly'>): string | null {
  if (!agent.project || agent.workDirectly) return null;
  return agent.project.split('/').filter(Boolean).pop() ?? null;
}
