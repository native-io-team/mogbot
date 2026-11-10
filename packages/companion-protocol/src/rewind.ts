/**
 * Rewind, fork and edit (`agents/rewind.rs`, docs/agents.md, "Rewind, fork
 * and edit"): three ways back from a wrong turn, on one of the user's own
 * messages. Shared by the desk and the phone so both offer and say the same.
 *
 * - **Edit and resend** puts the message back in the composer; sending it
 *   rewinds to just before it, then sends the new words there.
 * - **Fork from here** makes a new conversation with everything before it.
 * - **Rewind to here** carries on from just before it, in place.
 *
 * Nothing is deleted: what a rewind passes over stays in the chat, folded
 * under "Rewound". Files the agent changed and anything it sent aren't undone.
 */

/** A rewind as the Mac keeps it (`conversations::Rewind`). */
export interface Rewind {
  id: string;
  /** The user's message it went back to before. */
  at: string;
  ts: number;
  /** The lines it folded, that message first. */
  ids: string[];
}

/** Where a fork came from (`conversations::ForkedFromView`). */
export interface ForkedFrom {
  conversation: string;
  /** The user's message it was forked before. */
  message: string;
  /** That conversation's title; empty when it's gone. */
  title: string;
}

/** The three actions, in the order a menu lists them. */
export type GoBackAction = 'edit' | 'fork' | 'rewind';

export const GO_BACK_LABELS: Record<GoBackAction, string> = {
  edit: 'Edit and resend',
  fork: 'Fork from here',
  rewind: 'Rewind to here',
};

/** Which message lines are folded, and by which rewind. */
export function rewoundIds(rewinds: readonly Rewind[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rewinds ?? []) for (const id of r.ids) if (!out.has(id)) out.set(id, r.id);
  return out;
}

/** A chat's items with what a rewind passed over gathered into one fold each. */
export type Folded<T> =
  | { kind: 'item'; item: T }
  | { kind: 'rewound'; rewindId: string; items: T[] };

/**
 * Gather consecutive lines folded by the same rewind. `idsOf` names the
 * message ids an item stands for (a grouped item may stand for several); an
 * item is folded when every one of them is.
 */
export function foldRewound<T>(
  items: readonly T[],
  rewound: Map<string, string>,
  idsOf: (item: T) => readonly string[]
): Folded<T>[] {
  const out: Folded<T>[] = [];
  for (const item of items) {
    const ids = idsOf(item);
    const by = ids.length ? rewound.get(ids[0]) : undefined;
    const folded = by !== undefined && ids.every((id) => rewound.get(id) === by);
    if (!folded) {
      out.push({ kind: 'item', item });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === 'rewound' && last.rewindId === by) last.items.push(item);
    else out.push({ kind: 'rewound', rewindId: by, items: [item] });
  }
  return out;
}

/** The fold's summary line: "Rewound · 4 messages". */
export function rewoundSummary(count: number): string {
  return `Rewound · ${count} message${count === 1 ? '' : 's'}`;
}

/** A message as a confirm quotes it: its first line, at most 40 characters. */
export function goBackQuote(text: string): string {
  const first =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('>')) ?? '';
  return first.length > 40 ? `${first.slice(0, 40).trimEnd()}…` : first;
}

/** What isn't undone, said the same everywhere (`rewind::NOT_UNDONE`). */
export const GO_BACK_NOT_UNDONE = 'Files it changed and anything it sent since aren’t undone.';

/** What a project-bound agent's copy needs said. */
export function copyClause(project: string | null | undefined): string | null {
  if (!project) return null;
  return `Its copy of ${project} keeps its changes too: use Discard on its changes card to drop them.`;
}

/** The confirm for Rewind to here (and Edit and resend). */
export function rewindConfirm(
  agentName: string,
  text: string,
  project?: string | null
): { title: string; body: string; confirm: string } {
  const parts = [
    `${agentName} carries on from just before “${goBackQuote(text)}”. That message and what came after it stay in the chat, folded, not deleted.`,
    GO_BACK_NOT_UNDONE,
  ];
  const copy = copyClause(project);
  if (copy) parts.push(copy);
  return { title: 'Rewind to here?', body: parts.join(' '), confirm: 'Rewind' };
}

/** The confirm for Fork from here. */
export function forkConfirm(
  agentName: string,
  text: string,
  project?: string | null
): { title: string; body: string; confirm: string } {
  const parts = [
    `A new conversation with ${agentName}, with everything before “${goBackQuote(text)}”. This one stays as it is.`,
    GO_BACK_NOT_UNDONE,
  ];
  const copy = copyClause(project);
  if (copy) parts.push(copy);
  return { title: 'Fork from here?', body: parts.join(' '), confirm: 'Fork' };
}

/** The composer's bar while editing a sent message. */
export const EDITING_LINE = 'Editing your message. Sending goes back to just before it.';

/**
 * Why the actions are off right now, or null when they can be used. Going
 * back in place waits for the turn in progress; a fork never does.
 */
export function goBackBlocked(
  action: GoBackAction,
  state: { working: boolean; driven: boolean; agentName: string }
): string | null {
  if (action === 'fork') return null;
  if (state.driven) return `You’re driving ${state.agentName}’s session. Hand it back first.`;
  if (state.working) return `${state.agentName} is working. Wait for it to finish, or Stop it.`;
  return null;
}
