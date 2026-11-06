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

export const removeUsageAccount = (engine: AgentEngine, id: string) =>
  invoke<void>('agents_account_remove', { engine, id });

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
    // Out now says so with its reset; otherwise a past limit goes last.
    state: accountState({ ...a, email: undefined, limit: a.out ? a.limit : undefined }, now),
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
