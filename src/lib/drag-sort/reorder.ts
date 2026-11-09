import type { DragSortId, DragSortPlacement, DragSortPosition } from './types';

export type ItemIdGetter<T> = (item: T) => DragSortId;

function defaultItemId<T>(item: T): DragSortId {
  if (typeof item === 'object' && item !== null && 'id' in item) {
    return (item as { id: DragSortId }).id;
  }
  return item as unknown as DragSortId;
}

function key(id: DragSortId): string {
  return `${typeof id}:${String(id)}`;
}

/** Throw instead of silently picking one item when a scope has duplicate IDs. */
export function assertUniqueIds<T>(items: readonly T[], getId: ItemIdGetter<T>): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = getId(item);
    const itemKey = key(id);
    if (seen.has(itemKey)) throw new Error(`Drag-sort IDs must be unique: ${String(id)}`);
    seen.add(itemKey);
  }
}

/** Immutable move by final array indexes. `toIndex` is measured after removal. */
export function reorderFlat<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || fromIndex >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return next;
  const destination = Math.max(0, Math.min(toIndex, next.length));
  next.splice(destination, 0, item);
  return next;
}

/** Move an item before/inside/after a target. Inside is represented as a list move. */
export function projectFlatOrder<T>(
  items: readonly T[],
  activeId: DragSortId,
  targetId: DragSortId,
  placement: DragSortPlacement = 'after',
  getId: ItemIdGetter<T> = defaultItemId
): T[] {
  assertUniqueIds(items, getId);
  const from = items.findIndex((item) => key(getId(item)) === key(activeId));
  const target = items.findIndex((item) => key(getId(item)) === key(targetId));
  if (from < 0 || target < 0 || (from === target && placement === 'inside')) return [...items];

  const without = items.filter((_, index) => index !== from);
  const targetAfterRemoval = target - (from < target ? 1 : 0);
  let insertion = targetAfterRemoval;
  if (placement === 'after') insertion += 1;
  const [active] = items.slice(from, from + 1);
  if (active === undefined) return without;
  without.splice(Math.max(0, Math.min(insertion, without.length)), 0, active);
  return without;
}

export type GroupedItems<T> = Readonly<Record<string, readonly T[]>>;

/** Immutable move between named groups, including empty destination groups. */
export function projectGroupedOrder<T>(
  groups: GroupedItems<T>,
  move: { activeId: DragSortId; from: DragSortPosition; to: DragSortPosition },
  getId: ItemIdGetter<T> = defaultItemId
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  const seen = new Set<string>();
  for (const [group, items] of Object.entries(groups)) {
    result[group] = items.map((item) => {
      const id = getId(item);
      const itemKey = key(id);
      if (seen.has(itemKey)) throw new Error(`Drag-sort IDs must be unique: ${String(id)}`);
      seen.add(itemKey);
      return item;
    });
  }
  const fromGroup = String(move.from.group);
  const toGroup = String(move.to.group);
  const source = result[fromGroup] ?? [];
  const sourceIndex = source.findIndex((item) => key(getId(item)) === key(move.activeId));
  if (sourceIndex < 0) return result;
  const [active] = source.splice(sourceIndex, 1);
  if (active === undefined) return result;
  const destination = result[toGroup] ?? (result[toGroup] = []);
  const index = Math.max(0, Math.min(move.to.index, destination.length));
  destination.splice(index, 0, active);
  return result;
}

export interface DragSortTreeNode<T = unknown> {
  id: DragSortId;
  children?: readonly DragSortTreeNode<T>[];
  value?: T;
  [key: string]: unknown;
}

function containsId<T>(node: DragSortTreeNode<T>, id: DragSortId): boolean {
  return key(node.id) === key(id) || (node.children ?? []).some((child) => containsId(child, id));
}

/** Move a tree node without mutating the input; descendant moves are rejected. */
export function projectTree<T>(
  tree: readonly DragSortTreeNode<T>[],
  activeId: DragSortId,
  targetId: DragSortId,
  placement: DragSortPlacement
): DragSortTreeNode<T>[] {
  if (key(activeId) === key(targetId)) return tree.map((node) => ({ ...node }));
  const targetExists = tree.some((node) => containsId(node, targetId));
  if (!targetExists) return tree.map((node) => ({ ...node }));
  let active: DragSortTreeNode<T> | undefined;
  const remove = (nodes: readonly DragSortTreeNode<T>[]): DragSortTreeNode<T>[] =>
    nodes.flatMap((node) => {
      if (key(node.id) === key(activeId)) {
        active = node;
        return [];
      }
      return [
        {
          ...node,
          ...(node.children ? { children: remove(node.children) } : {}),
        },
      ];
    });
  const without = remove(tree);
  if (!active || containsId(active, targetId)) return tree.map((node) => ({ ...node }));

  const insert = (nodes: readonly DragSortTreeNode<T>[]): DragSortTreeNode<T>[] =>
    nodes.flatMap((node) => {
      if (key(node.id) === key(targetId)) {
        if (placement === 'inside') {
          return [{ ...node, children: [...(node.children ?? []), active!] }];
        }
        return placement === 'before' ? [active!, node] : [node, active!];
      }
      return [
        {
          ...node,
          ...(node.children ? { children: insert(node.children) } : {}),
        },
      ];
    });
  return insert(without);
}
