/**
 * Which account is working, and every other one to swap to: the desk's
 * sidebar row and its popover, ⌘K "Switch account…", and the phone's
 * Accounts, worded once here so the two never disagree.
 *
 * Pure, and only what the Mac serves: the accounts in the order turns try
 * them (`agents.accounts`, `agents::wallet`), and each account's last
 * reading when the Mac sent the inventory (`agents.usagePlan`). No reading,
 * no figure: an account nobody has read says so rather than showing 100%.
 *
 * "In use" is the account the team's next turn starts on: the first one,
 * in order, that is signed in and not out (`wallet::choose`). "Use this one
 * now" puts an account first (`agents.accounts.use`); a turn already running
 * finishes on its own account, and an agent set to one account stays on it.
 */

import type {
  AgentEngine,
  QuotaWindow,
  UsageAccount,
  UsageAccountLine,
  UsageInventory,
} from './model';
import { QUOTA_WARN_PERCENT, resetPhrase } from './quota';
import { planLabel, type UsageTone } from './usage';
import { awayRoom, type AwayState } from './crossover';

export const ACCOUNT_ENGINE_LABEL: Record<AgentEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** Why more than one account: said once, wherever one is added. */
export const ADD_ACCOUNT_WHY =
  'When one account runs out of usage, agents carry on with the next, so nothing stops.';

/** Where the phone sends anything it can't do itself. */
export const ADD_ON_MAC = 'Add or sign in to accounts on your Mac: Agents → Usage.';

/**
 * The names a Mac gives an account nobody named, which describe a place,
 * not an account ("This Mac" from older Macs, "Signed in on this Mac" when
 * the engine doesn't record who). Never shown as an account's name.
 */
const PLACE_NAMES = new Set(['this mac', 'signed in on this mac']);

/** A Claude organization named after its owner by default ("Sam’s Organization") says nothing new. */
const DEFAULT_ORG = /['’]s Organization$/;

/** Whose plan it is, for a name made from it: "Claude Max", "ChatGPT Plus". */
const PLAN_OWNER: Record<AgentEngine, string> = { claude: 'Claude', codex: 'ChatGPT' };

const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/**
 * An account's name, the same on the desk and the phone: the name the user
 * gave it; else who it is signed in as (the email); else its organization;
 * else its plan ("Claude Max"); else "Claude Code account". Never "This
 * Mac": that is where it is signed in, said in its detail, not whose it is.
 */
export function accountLabel(
  a: Pick<UsageAccount, 'engine' | 'name' | 'named' | 'email' | 'plan'>,
  line?: Pick<UsageAccountLine, 'orgName' | 'plan'> | null
): string {
  const given = a.name.trim();
  const place = PLACE_NAMES.has(given.toLowerCase());
  // An older Mac doesn't say whether it was named: any name but a place's was.
  if (given !== '' && !place && (a.named ?? true)) return given;
  if (a.email) return a.email;
  const org = line?.orgName?.trim();
  if (org && !DEFAULT_ORG.test(org)) return org;
  const plan = a.plan ?? line?.plan;
  if (plan) return `${PLAN_OWNER[a.engine]} ${capital(plan)}`;
  return `${ACCOUNT_ENGINE_LABEL[a.engine]} account`;
}

/** One limit's room: "62% left", with its reset. */
export interface RoomLimit {
  key: string;
  /** "5-hour" or "Weekly". */
  label: string;
  /** 0–100 left, floored the other way: never more room than reported. */
  left: number;
  /** "resets 3:20 PM", "resets Sat 2:00 PM"; absent when not reported. */
  resets?: string;
  tone: UsageTone;
}

export interface SwitcherRow {
  key: string;
  engine: AgentEngine;
  id: string;
  name: string;
  /** Who it's signed in as when the name doesn't already say, its plan, and whether it's this Mac's own. */
  detail: string[];
  /** The team's next turn starts on it. */
  inUse: boolean;
  /** "In use", "Ready", "Out of usage until Sat 2:00 PM", "Not signed in". */
  state: string;
  tone: 'ok' | 'out' | 'off';
  /** The 5-hour and the all-models week, as last reported; empty: no reading. */
  room: RoomLimit[];
  /** "Use this one now" would change something, and can. */
  canUse: boolean;
  /** Agents set to run only on it. */
  pinnedBy: string[];
  signedIn: boolean;
  thisMac: boolean;
  /** Renaming starts from the name shown. */
  named: boolean;
}

export interface SwitcherEngine {
  engine: AgentEngine;
  label: string;
  rows: SwitcherRow[];
  /** Every signed-in account is out. */
  allOut: boolean;
}

const isSession = (w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>) =>
  w.kind === 'five_hour' || w.windowMinutes === 300;
const isWeek = (w: Pick<QuotaWindow, 'kind' | 'windowMinutes'>) =>
  w.kind === 'seven_day' ||
  (w.kind !== 'seven_day_opus' && w.kind !== 'seven_day_sonnet' && w.windowMinutes === 7 * 24 * 60);

function limitOf(w: QuotaWindow | undefined, label: string, now: number): RoomLimit | null {
  if (!w || (w.resetsAt !== undefined && w.resetsAt <= now)) return null;
  if (!w.limited && w.usedPercent === undefined) return null;
  const used = w.limited ? 100 : Math.max(0, Math.min(100, Math.ceil(w.usedPercent ?? 0)));
  const left = 100 - used;
  return {
    key: label,
    label,
    left,
    resets: w.resetsAt ? `resets ${resetPhrase(w.resetsAt, now)}` : undefined,
    tone: left <= 0 ? 'limited' : used >= QUOTA_WARN_PERCENT ? 'warning' : 'calm',
  };
}

/** The 5-hour and the week, as last reported, in that order. */
export function roomOf(windows: QuotaWindow[], now = Date.now()): RoomLimit[] {
  return [
    limitOf(windows.find(isSession), '5-hour', now),
    limitOf(windows.find(isWeek), 'Weekly', now),
  ].filter((r): r is RoomLimit => r !== null);
}

/** The account the next turn starts on: as `wallet::choose` picks it, with no tries yet. */
export function inUseOf(mine: UsageAccount[]): UsageAccount | undefined {
  const usable = mine.filter((a) => a.signedIn);
  if (usable.length <= 1) return usable[0] ?? mine[0];
  return usable.find((a) => !a.out);
}

function stateOf(
  a: UsageAccount,
  inUse: boolean,
  now: number
): Pick<SwitcherRow, 'state' | 'tone'> {
  if (!a.signedIn) return { state: 'Not signed in', tone: 'off' };
  if (a.out) {
    return {
      state:
        a.limit?.resetsAt && a.limit.resetsAt > now
          ? `Out of usage until ${resetPhrase(a.limit.resetsAt, now)}`
          : 'Out of usage · reset time not reported',
      tone: 'out',
    };
  }
  return { state: inUse ? 'In use' : 'Ready', tone: 'ok' };
}

function detailOf(a: UsageAccount, name: string): string[] {
  const out: string[] = [];
  // The name is the email or the plan when nobody named it: never twice.
  if (a.email && a.email !== name) out.push(a.email);
  if (a.plan && !name.endsWith(` ${capital(a.plan)}`)) out.push(planLabel(a.plan));
  // Where it is signed in: a detail, never its name.
  if (a.thisMac) out.push('this Mac’s own sign-in');
  return out;
}

/**
 * Every engine with its accounts, in the order turns try them. Engines
 * with no agents and only this Mac's unsigned sign-in are left out by the
 * caller choosing `engines`.
 */
export function switcherView(
  accounts: UsageAccount[],
  inventory: UsageInventory | null | undefined,
  opts: {
    now?: number;
    /** Which engines to show; default every engine in `accounts`. */
    engines?: AgentEngine[];
    /** Agents set to one account: their names, by `engine:id`. */
    pins?: { engine: AgentEngine; account: string; name: string }[];
  } = {}
): SwitcherEngine[] {
  const now = opts.now ?? Date.now();
  const engines = opts.engines ?? [...new Set(accounts.map((a) => a.engine))];
  return engines
    .map((engine) => {
      const mine = accounts.filter((a) => a.engine === engine);
      const next = inUseOf(mine);
      const signedIn = mine.filter((a) => a.signedIn);
      const rows = mine.map((a): SwitcherRow => {
        const inUse = next?.id === a.id;
        const line = inventory?.accounts.find((l) => l.engine === engine && l.id === a.id);
        const { state, tone } = stateOf(a, inUse, now);
        const name = accountLabel(a, line);
        return {
          key: `${engine}:${a.id}`,
          engine,
          id: a.id,
          name,
          detail: detailOf(a, name),
          inUse,
          state,
          tone,
          room: a.signedIn ? roomOf(line?.windows ?? [], now) : [],
          canUse: a.signedIn && !a.out && !inUse,
          pinnedBy: (opts.pins ?? [])
            .filter((p) => p.engine === engine && p.account === a.id)
            .map((p) => p.name),
          signedIn: a.signedIn,
          thisMac: a.thisMac,
          named: a.named ?? a.name !== 'This Mac',
        };
      });
      return {
        engine,
        label: ACCOUNT_ENGINE_LABEL[engine],
        rows,
        allOut: signedIn.length > 1 && signedIn.every((a) => a.out),
      };
    })
    .filter((e) => e.rows.length > 0);
}

/** "62% left": the tighter of the 5-hour and the week, the one that stops a turn first. */
export function roomShort(room: RoomLimit[]): RoomLimit | null {
  if (room.length === 0) return null;
  return room.reduce((a, b) => (b.left < a.left ? b : a));
}

/** The sidebar's row for one engine: the account working now and its room. */
export interface WorkingLine {
  engine: AgentEngine;
  /** "Work", "sam@example.com". */
  name: string;
  /** "62% left", "Out of usage until 3:20 PM", "Not signed in"; absent: no reading. */
  room?: string;
  tone: 'ok' | 'warning' | 'out' | 'off';
  /** For the tooltip and screen readers, in a sentence. */
  detail: string;
  /** The engine has more than one account (so there is something to swap to). */
  several: boolean;
  /** Agents carry on with the other engine (`crossover`): the name, short, never truncates. */
  away?: boolean;
}

/**
 * `away`: agents of this engine are carrying on with the other while every
 * account they may use is out (`agents/crossover.rs`): the line says so,
 * "Claude Code out · on Codex until 4:00 PM", whatever the rows say.
 */
export function workingLine(
  view: SwitcherEngine,
  away?: AwayState | null,
  now = Date.now()
): WorkingLine | null {
  // All out: nothing is in use; the line names the first, and that all are out.
  const row =
    view.rows.find((r) => r.inUse) ?? (view.allOut ? view.rows.find((r) => r.signedIn) : undefined);
  const several = view.rows.length > 1;
  const engine = ACCOUNT_ENGINE_LABEL[view.engine];
  if (away && away.home === view.engine) {
    const who = away.count === 1 ? '1 agent is' : `${away.count} agents are`;
    return {
      engine: view.engine,
      // Short: the row is narrow, and the room says where they went.
      name: `${view.engine === 'claude' ? 'Claude' : 'Codex'} out`,
      // "Claude out · on Codex": what fits the sidebar's row; until when
      // is in its detail (the tooltip) and in Settings → Agents → Usage.
      room: `on ${ACCOUNT_ENGINE_LABEL[away.on]}`,
      tone: 'warning',
      away: true,
      detail: `Every ${engine} account is out of usage: ${who} carrying on with ${ACCOUNT_ENGINE_LABEL[away.on]}${away.until ? ` ${awayRoom(away, now).replace(/^on \S+ /, '')}` : ''}, then back to ${engine}.`,
      several,
    };
  }
  if (!row) return null;
  if (view.allOut) {
    const back = view.rows.map((r) => r.state).find((s) => s.startsWith('Out of usage until'));
    return {
      engine: view.engine,
      name: row.name,
      room: 'Out of usage',
      tone: 'out',
      detail: `Every ${engine} account is out of usage.${back ? ` ${row.name}: ${back.toLowerCase()}.` : ''}`,
      several,
    };
  }
  if (!row.signedIn) {
    return {
      engine: view.engine,
      name: row.name,
      room: 'Not signed in',
      tone: 'off',
      detail: `${row.name} isn’t signed in to ${engine}.`,
      several,
    };
  }
  if (row.tone === 'out') {
    return {
      engine: view.engine,
      name: row.name,
      room: row.state,
      tone: 'out',
      detail: `${row.name}: ${row.state.toLowerCase()}.`,
      several,
    };
  }
  const tight = roomShort(row.room);
  const lead = `Agents on ${engine} are using ${row.name}.`;
  return {
    engine: view.engine,
    name: row.name,
    room: tight ? `${tight.left}% left` : undefined,
    tone: tight && tight.tone !== 'calm' ? (tight.tone === 'limited' ? 'out' : 'warning') : 'ok',
    detail: tight
      ? `${lead} ${tight.left}% of its ${tight.label.toLowerCase()} limit left${tight.resets ? `, ${tight.resets}` : ''}.`
      : `${lead} No usage reading yet.`,
    several,
  };
}

/** "Riley runs only on this one", "Riley and Max run only on this one". */
export function pinnedLine(names: string[]): string | null {
  if (names.length === 0) return null;
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${who} ${names.length === 1 ? 'runs' : 'run'} only on this one`;
}

/** The order after moving one row by `by` (−1 earlier, +1 later), or null at an end. */
export function movedIds(ids: string[], from: number, by: -1 | 1): string[] | null {
  const to = from + by;
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The order after "Use this one now": it first, the rest as they were. */
export function usedFirst(ids: string[], id: string): string[] {
  return ids.includes(id) ? [id, ...ids.filter((i) => i !== id)] : ids;
}
