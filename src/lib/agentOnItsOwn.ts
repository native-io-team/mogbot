/**
 * "What can this agent do without asking me?" (`src-tauri/src/agents/on_its_own.rs`):
 * the invoke wrappers, over the types and words shared with the phone
 * (`packages/companion-protocol/src/onItsOwn.ts`). Narrowing only: the Mac
 * applies a narrow only when the agent's current view offers it.
 *
 * @module lib/agentOnItsOwn
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  OnItsOwn,
  OnItsOwnNarrow,
  OnItsOwnTeam,
} from '../../packages/companion-protocol/src/onItsOwn';

export type {
  OnItsOwn,
  OnItsOwnItem,
  OnItsOwnKind,
  OnItsOwnNarrow,
  OnItsOwnTeam,
  OnItsOwnTeamRow,
} from '../../packages/companion-protocol/src/onItsOwn';
export {
  ON_ITS_OWN_ALWAYS_ASKS,
  ON_ITS_OWN_FOOT,
  ON_ITS_OWN_MENU,
  ON_ITS_OWN_NONE,
  ON_ITS_OWN_STANDING,
  ON_ITS_OWN_TEAM_TITLE,
  narrowA11y,
  narrowKey,
  narrowLabel,
  onItsOwnIsBare,
  onItsOwnLevel,
  onItsOwnSections,
  onItsOwnTeamRowLine,
  onItsOwnTitle,
  timeLeftLine,
} from '../../packages/companion-protocol/src/onItsOwn';

export const agentOnItsOwn = (agentId: string) =>
  invoke<OnItsOwn>('agents_on_its_own', { agentId });

export const teamOnItsOwn = () => invoke<OnItsOwnTeam>('agents_on_its_own_team');

export const narrowOnItsOwn = (agentId: string, narrow: OnItsOwnNarrow) =>
  invoke<OnItsOwn>('agents_on_its_own_narrow', { agentId, narrow });
