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
  accountTags,
  accountUsage,
  estimateLine,
  localLine,
  spareLine,
  windowLine,
  type SpareLine,
  type UsageTone,
} from '../../packages/companion-protocol/src/usage';
export { windowName } from '../../packages/companion-protocol/src/quota';
// The chat header's ring and its popover say what the phone's do.
export {
  accountBlocks,
  computeForecast,
  computeRows,
  computeView,
  contextMeter,
  type ComputeRow,
  type ComputeView,
  paceLine,
  planUsage,
  ringPercent,
  usageSheet,
  type AccountBlock,
  type ActiveUsage,
  type PaceLine,
  type PlanUsage,
  type UsageMeter,
  type UsageSheet,
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
 * "Give agents something to do": the Chief starts the spare-capacity list
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
  type KeyState,
  type LowBar,
  type SpareNudge,
  type StackEngine,
  type StackKey,
  type UsageGlance,
} from '../../packages/companion-protocol/src/usageGlance';
