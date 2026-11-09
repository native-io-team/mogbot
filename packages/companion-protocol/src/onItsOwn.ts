/**
 * "What can this agent do without asking me?" (`agents/on_its_own.rs`), the
 * same calm view on the desk and the phone: its level and that level's one
 * line, what always asks, and every standing rule in plain words, each with
 * the one tap that takes it away. Item words come from the Mac (the same
 * words the Chief reads with `what_it_does_on_its_own`); the headings,
 * buttons and empty states are here, once.
 *
 * Nothing here gives: every `OnItsOwnNarrow` takes something away, and the
 * Mac applies one only when its current view offers it. Widening stays on
 * cards and in Settings.
 */

import type { AgentIndependence } from './model';
import { INDEPENDENCE_LABEL } from './independence';

export type OnItsOwnKind =
  | 'rule'
  | 'said'
  | 'team_rule'
  | 'plan'
  | 'app'
  | 'browser'
  | 'admin'
  | 'account'
  | 'slack';

/** One tap that takes something away. */
export type OnItsOwnNarrow =
  | { kind: 'rule'; ruleId: string }
  | { kind: 'plan'; grantId: string }
  | { kind: 'app'; connectionId: string }
  | { kind: 'app_read_only'; connectionId: string }
  | { kind: 'browser' }
  | { kind: 'admin' }
  | { kind: 'exact_text' };

export interface OnItsOwnItem {
  key: string;
  kind: OnItsOwnKind;
  /** What it may do, in the Mac's plain words. */
  text: string;
  detail?: string;
  /** When it stops by itself (a plan), epoch ms. */
  endsAt?: number;
  /** What one tap may take away; empty when it's only shown here. */
  narrow: OnItsOwnNarrow[];
}

export interface OnItsOwn {
  agentId: string;
  agentName: string;
  level: AgentIndependence;
  /** Its own level rather than the team's. */
  ownLevel: boolean;
  levelLine: string;
  alwaysAsks: string[];
  items: OnItsOwnItem[];
}

export interface OnItsOwnTeamRow {
  agentId: string;
  name: string;
  level: AgentIndependence;
  ownLevel: boolean;
  /** Standing items beyond its level (its accounts and the team's rules aside). */
  standing: number;
}

export interface OnItsOwnTeam {
  level: AgentIndependence;
  levelLine: string;
  alwaysAsks: string[];
  teamRules: OnItsOwnItem[];
  agents: OnItsOwnTeamRow[];
}

/* ------------------------------------------------------------ words */

/**
 * The view's title, and how ⌘K names it. Independence is the one name for
 * "how much an agent does on its own" (`independence.ts`): its level, and
 * what it may do beyond it.
 */
export const onItsOwnTitle = (name: string) => `${name}’s independence`;

/** The team's: Settings → Independence and the phone's Settings. */
export const ON_ITS_OWN_TEAM_TITLE = 'Each agent’s independence';

/** The menu item on an agent's controls. */
export const ON_ITS_OWN_MENU = 'Independence…';

/** Its level, and whose: "Bold · the team's level". */
export function onItsOwnLevel(level: AgentIndependence, own: boolean): string {
  return `${INDEPENDENCE_LABEL[level]} · ${own ? 'its own level' : 'the team’s level'}`;
}

/** Over the floor's lines: true whatever its rules and level say. */
export const ON_ITS_OWN_ALWAYS_ASKS = 'Whatever the rules say';
export const ON_ITS_OWN_STANDING = 'Without asking, beyond its level';
export const ON_ITS_OWN_NONE =
  'Nothing beyond its level. Always allow on a card, a plan you OK, or an app you connect would show here.';

/** Under the list: where widening happens, said once. */
export const ON_ITS_OWN_FOOT =
  'Taking something away applies at once. Giving more is always a card in the chat.';

/** Section headings, in the order the sections are shown. */
export const ON_ITS_OWN_SECTIONS: readonly { title: string; kinds: readonly OnItsOwnKind[] }[] = [
  { title: 'Rules', kinds: ['rule', 'said', 'team_rule'] },
  { title: 'Plans you OK’d', kinds: ['plan'] },
  { title: 'Apps', kinds: ['app'] },
  { title: 'Browser', kinds: ['browser'] },
  { title: 'Team and accounts', kinds: ['admin', 'slack', 'account'] },
];

/** Items grouped as `ON_ITS_OWN_SECTIONS`, empty sections left out. */
export function onItsOwnSections(
  items: readonly OnItsOwnItem[]
): { title: string; items: OnItsOwnItem[] }[] {
  return ON_ITS_OWN_SECTIONS.map((s) => ({
    title: s.title,
    items: items.filter((i) => s.kinds.includes(i.kind)),
  })).filter((s) => s.items.length > 0);
}

/** Whether only its accounts are listed: nothing else stands beyond its level. */
export function onItsOwnIsBare(view: Pick<OnItsOwn, 'items'>): boolean {
  return view.items.every((i) => i.kind === 'account');
}

/** The button for one narrow. */
export function narrowLabel(n: OnItsOwnNarrow): string {
  switch (n.kind) {
    case 'app_read_only':
      return 'Read only';
    case 'plan':
      return 'Take back';
    case 'admin':
      return 'Turn off';
    case 'browser':
      return 'Turn off';
    case 'exact_text':
      return 'Ask first';
    default:
      return 'Remove';
  }
}

/** What a screen reader hears for the button. */
export function narrowA11y(n: OnItsOwnNarrow, item: Pick<OnItsOwnItem, 'text'>): string {
  return `${narrowLabel(n)}: ${item.text}`;
}

/** A stable key for a narrow (lists, busy state). */
export function narrowKey(n: OnItsOwnNarrow): string {
  switch (n.kind) {
    case 'rule':
      return `rule:${n.ruleId}`;
    case 'plan':
      return `plan:${n.grantId}`;
    case 'app':
    case 'app_read_only':
      return `${n.kind}:${n.connectionId}`;
    default:
      return n.kind;
  }
}

/** "42 min left", "1 hr left", "Ending now"; from the Mac's end time. */
export function timeLeftLine(endsAt: number, now: number): string {
  const min = Math.ceil((endsAt - now) / 60_000);
  if (min <= 0) return 'Ending now';
  if (min < 60) return `${min} min left`;
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hr} hr ${rest} min left` : `${hr} hr left`;
}

/** The team's row for one agent: "Unleashed (its own) · 3 standing". */
export function onItsOwnTeamRowLine(row: OnItsOwnTeamRow): string {
  const level = `${INDEPENDENCE_LABEL[row.level]}${row.ownLevel ? ' (its own)' : ''}`;
  if (row.standing === 0) return `${level} · nothing beyond its level`;
  return `${level} · ${row.standing} beyond its level`;
}
