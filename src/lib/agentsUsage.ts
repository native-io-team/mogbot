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
  SpareItem,
  UsageInventory,
  UsageMode,
} from '../../packages/companion-protocol/src/model';

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

export const setUsageMode = (mode: UsageMode) => invoke<void>('agents_set_usage_mode', { mode });

export const addSpareItem = (text: string, agentId?: string) =>
  invoke<SpareItem>('agents_spare_add', { text, agentId: agentId ?? null });

export const removeSpareItem = (id: string) => invoke<void>('agents_spare_remove', { id });

export const onUsagePlanChanged = (fn: () => void): Promise<UnlistenFn> =>
  listen(USAGE_PLAN_EVENT, fn);
