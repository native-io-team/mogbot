/**
 * What each agent may do (`src-tauri/src/agents/policy.rs`): the invoke
 * wrappers, over the types and words shared with the phone
 * (`packages/companion-protocol/src/policy.ts`). The usual way to change any
 * of it is chat: an agent proposes it and a card asks the user
 * (`propose_settings_change`, `agents/policy_card.rs`); the desk's screens
 * are the secondary way.
 *
 * @module lib/agentPolicy
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  AgentPolicyView,
  PolicyChange,
  PolicyTarget,
  TeamPolicyView,
} from '../../packages/companion-protocol/src/policy';

export type {
  AgentPolicyView,
  AppsMode,
  PolicyChange,
  PolicyEffective,
  PolicyFolder,
  PolicyLine,
  PolicyPreset,
  PolicyTarget,
  PresetInfo,
  ProjectHow,
  ProjectScope,
  SettingsGroup,
  SettingsProposal,
  TeamPolicyView,
} from '../../packages/companion-protocol/src/policy';
export {
  ENFORCED_NOTE,
  HOW_LABEL,
  PRESET_LABEL,
  RULES_NOTE,
  chatDraft,
  resetLabel,
  settingsLines,
} from '../../packages/companion-protocol/src/policy';

/** Fired by the Mac whenever any agent's settings change. */
export const POLICY_EVENT = 'agents://policy';

export const agentPolicy = (agentId: string) =>
  invoke<AgentPolicyView>('agents_policy', { agentId });

export const teamPolicy = () => invoke<TeamPolicyView>('agents_policy_team');

export const setPolicy = (target: PolicyTarget, change: PolicyChange) =>
  invoke<void>('agents_policy_set', { target, change });
