/**
 * The capacity inventory (`agents::inventory`): every engine and account
 * with what it last reported, other compute on this Mac, windows near a
 * reset with capacity left, estimates from past runs, the usage mode and the
 * spare-capacity list. Worded once for the desk and the phone by the
 * companion protocol's `usage.ts`.
 *
 * Readings are only what an engine reported; estimates are always labelled
 * as estimates, and absent with too little history.
 *
 * @module lib/agentsUsage
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AgentEngine,
  SpareItem,
  UsageInventory,
  UsageMode,
} from '../../packages/companion-protocol/src/model';
import type { CrossoverMode, CrossoverView } from '../../packages/companion-protocol/src/crossover';

export type {
  LocalCompute,
  SpareItem,
  SpareWindow,
  UsageAccountLine,
  UsageEstimate,
  UsageInventory,
  UsageMode,
} from '../../packages/companion-protocol/src/model';
export {
  USAGE_MODES,
  USAGE_MODE_DETAIL,
  USAGE_MODE_LABEL,
  estimateLine,
  localLine,
  spareLine,
} from '../../packages/companion-protocol/src/usage';
// The chat header's ring: what is left of the 5-hour window, and the context meter.
export {
  contextMeter,
  ringPercent,
  type UsageMeter,
} from '../../packages/companion-protocol/src/usageSheet';

/** The mode or the list changed (`runner::EVENT_USAGE_PLAN`). */
export const USAGE_PLAN_EVENT = 'agents://usage-plan';

export const getUsageInventory = () => invoke<UsageInventory>('agents_usage_overview');

/** What is known, without asking for a read: a glance, not someone looking. */
export const glanceUsageInventory = () =>
  invoke<UsageInventory>('agents_usage_overview', { look: false });

export const setUsageMode = (mode: UsageMode) => invoke<void>('agents_set_usage_mode', { mode });

/** When every account of an engine is out: each engine's choice, and who is carrying on elsewhere. */
export const getCrossover = () => invoke<CrossoverView>('agents_crossover');

export const setCrossover = (engine: AgentEngine, mode: CrossoverMode) =>
  invoke<CrossoverView>('agents_set_crossover', { engine, mode });

export const addSpareItem = (text: string, agentId?: string) =>
  invoke<SpareItem>('agents_spare_add', { text, agentId: agentId ?? null });

export const removeSpareItem = (id: string) => invoke<void>('agents_spare_remove', { id });

export const onUsagePlanChanged = (fn: () => void): Promise<UnlistenFn> =>
  listen(USAGE_PLAN_EVENT, fn);

/**
 * "Give agents something to do": the Chief starts the list of ideas for leftover usage
 * now on a window near its reset with room left (`agents_spare_spend_now`).
 * Answers the line to show.
 */
export const spendSpareNow = () => invoke<string>('agents_spare_spend_now');

// The stack of accounts, at a glance and in full (the sidebar meter and Usage view).
export {
  LOW_LEFT,
  OUT_OF_USAGE,
  elsewhereLine,
  relativeIn,
  usageGlance,
  type ChangeLine,
  type KeyLimit,
  type AccountKeyState,
  type LowBar,
  type SpareNudge,
  type StackEngine,
  type StackKey,
  type UsageGlance,
  type GlanceRowWords,
  type SignInChangedNotice,
  type UsageTotal,
  type TotalSegment,
  type AgentSpend,
} from '../../packages/companion-protocol/src/usageGlance';
export {
  ADD_IT,
  NOT_NOW,
  REMOVE_ACCOUNT,
  SIGN_IN_DIFFERENT,
  TRY_AGAIN_DIFFERENT,
  addedSameAccount,
  browserSteps,
  browserWarning,
} from '../../packages/companion-protocol/src/sameAccount';

/** "This Mac's Claude Code is now signed in as …" was answered: not said again. */
export const markSignInChangeSeen = (key: string) =>
  invoke<void>('agents_usage_sign_in_seen', { key });

/**
 * Right after an account is signed in: read it once and say whether it's an
 * account already in the list (`sameAs`, that one's id).
 */
export const checkNewAccount = (engine: AgentEngine, id: string) =>
  invoke<{ sameAs?: string }>('agents_usage_check_account', { engine, id });
