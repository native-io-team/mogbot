/**
 * Usage accounts ("usage wallets"): more than one Claude Code or Codex
 * account, so agents keep working when one reaches its usage limit.
 *
 * Mirrors `src-tauri/src/agents/wallet.rs`. Each engine's accounts are in
 * priority order; the first is this Mac's own sign-in. A turn that ends on
 * the usage limit marks its account out and continues on the next. Nothing
 * here is estimated: a limit and its reset are shown only when a turn hit
 * one and the engine said when it resets.
 *
 * @module lib/agentAccounts
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentEngine } from './agents';
import { ENGINE_LABEL } from './agents';
import type { UsageAccount } from '../../packages/companion-protocol/src/model';
import { accountState } from '../../packages/companion-protocol/src/accounts';
import { planLabel } from '../../packages/companion-protocol/src/usage';
import { readDay } from '../../packages/companion-protocol/src/quota';

/** One shape on the desk and the phone (`agents::wallet::AccountView`). */
export type {
  UsageAccount,
  UsageLimitHit as LimitHit,
} from '../../packages/companion-protocol/src/model';

export const ACCOUNTS_EVENT = 'agents-accounts-changed';

export const listUsageAccounts = () => invoke<UsageAccount[]>('agents_accounts');

export const addUsageAccount = (engine: AgentEngine, name: string) =>
  invoke<UsageAccount>('agents_account_add', { engine, name });

export const renameUsageAccount = (engine: AgentEngine, id: string, name: string) =>
  invoke<UsageAccount>('agents_account_rename', { engine, id, name });

export const reorderUsageAccounts = (engine: AgentEngine, ids: string[]) =>
  invoke<UsageAccount[]>('agents_account_reorder', { engine, ids });

/**
 * What removing an account did. `waiting`: a turn is running on it, so it
 * left the list now and its sign-in goes when that turn ends ("Removing
 * after Finance's turn ends."). Absent when it went at once.
 */
export interface AccountRemoval {
  waiting?: string;
}

export const removeUsageAccount = (engine: AgentEngine, id: string) =>
  invoke<AccountRemoval | null>('agents_account_remove', { engine, id });

/** The line to show after a removal, when it waits on a turn. */
export const removalLine = (removal: AccountRemoval | null | undefined): string | null =>
  removal?.waiting ?? null;

/**
 * "Use this one now": it goes first in its engine's order, so every turn
 * that starts from now on tries it first. A turn already running finishes
 * on its account; an agent set to one account stays on it. Answers the
 * accounts in their new order.
 */
export const putAccountFirst = (engine: AgentEngine, id: string) =>
  invoke<UsageAccount[]>('agents_account_use', { engine, id });

/* The sidebar's account row, opened from ⌘K ("Switch account…", "Add an account…"). */
export type SwitcherRequest = 'open' | 'add';
const switcherListeners = new Set<(what: SwitcherRequest) => void>();

/** Whether the account row is on screen to open (Agents is showing). */
export function switcherMounted(): boolean {
  return switcherListeners.size > 0;
}

export function onSwitcherRequest(fn: (what: SwitcherRequest) => void): () => void {
  switcherListeners.add(fn);
  return () => switcherListeners.delete(fn);
}

/** Open the account row's popover; false when it isn't on screen. */
export function requestSwitcher(what: SwitcherRequest): boolean {
  if (switcherListeners.size === 0) return false;
  switcherListeners.forEach((fn) => fn(what));
  return true;
}

export const onUsageAccountsChanged = (fn: () => void): Promise<UnlistenFn> =>
  listen(ACCOUNTS_EVENT, fn);

/** One engine's accounts, in their order. */
export function accountsOf(all: UsageAccount[], engine: AgentEngine): UsageAccount[] {
  return all.filter((a) => a.engine === engine);
}

/** `ids` with the one at `from` moved by `by` (−1 up, +1 down), or null at an end. */
export function moved(ids: string[], from: number, by: -1 | 1): string[] | null {
  const to = from + by;
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The account's one-line state, worded once for the desk and the phone. */
export { accountState } from '../../packages/companion-protocol/src/accounts';

/**
 * The row's second line, in parts so the email is what truncates: the state
 * ("Signed in", "Not signed in", "Out of usage until …"), who it is signed
 * in as and its plan, each only when the engine reported it, and only while
 * it is signed in; then a past limit (last limit Mon).
 */
export function accountDetail(
  a: UsageAccount,
  now = Date.now()
): { state: string; email?: string; plan?: string; note?: string } {
  if (!a.signedIn) return { state: accountState({ ...a, email: undefined }, now) };
  return {
    // Out now says so with its reset; otherwise "Ready", as the popover and
    // the phone say it (a past limit goes last, in `note`).
    state: a.out ? accountState({ ...a, email: undefined }, now) : 'Ready',
    email: a.email,
    plan: a.plan ? planLabel(a.plan) : undefined,
    note: !a.out && a.limit ? `last limit ${readDay(a.limit.at, now)}` : undefined,
  };
}

/** What the row is called, in its tooltip. */
export function accountKind(a: UsageAccount): string {
  return a.thisMac
    ? `This Mac’s own ${ENGINE_LABEL[a.engine]} sign-in`
    : `Added here · its own ${ENGINE_LABEL[a.engine]} sign-in`;
}

/** A name for a new account that isn't taken yet. */
export function suggestName(existing: UsageAccount[], engine: AgentEngine): string {
  const taken = new Set(accountsOf(existing, engine).map((a) => a.name.toLowerCase()));
  for (let n = 2; ; n += 1) {
    const name = `Account ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/* A request from the palette, picked up when Settings → Agents mounts. */
let pendingAdd: AgentEngine | 'show' | null = null;

/** Ask the Accounts area to start adding one (or just be shown) when it opens. */
export function requestAccountsOnOpen(what: AgentEngine | 'show') {
  pendingAdd = what;
}

export function takeAccountsRequest(): AgentEngine | 'show' | null {
  const what = pendingAdd;
  pendingAdd = null;
  return what;
}
