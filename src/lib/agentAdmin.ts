/**
 * Admins (`agents::admin`): agents the user lets manage, and answer for, the
 * rest of the team. One switch per agent, on for the Chief of Staff by
 * default. Only the user sets it (the agent editor, the phone); an admin
 * answers other agents' local work and puts logins away, and brings
 * everything else (spending, sending, publishing, pushing, sharing, keys) to
 * the user in one message. Admin deletes are soft: Recently deleted keeps an
 * agent for 30 days.
 *
 * @module lib/agentAdmin
 */

import { invoke } from '@tauri-apps/api/core';
import type { Agent, AgentRef } from './agents';

export { isAdmin } from '../../packages/companion-protocol/src/model';

export const ADMIN_LABEL = 'Admin';
export const ADMIN_DETAIL =
  'Can manage and approve for other agents: answers their local work, clears logins nobody needs, pauses, briefs and removes them. Spending, sending, publishing, pushing, sharing and keys still come to you.';

/** The user's own switch; the registry event refreshes the store. */
export const setAdmin = (agentId: string, admin: boolean) =>
  invoke<Agent>('agents_set_admin', { agentId, admin });

/** Mirrors `admin::Activity`. */
export interface AdminActivity {
  ts: number;
  admin: AgentRef;
  target?: AgentRef;
  action: string;
}

export const adminActivity = (limit?: number) =>
  invoke<AdminActivity[]>('agents_admin_activity', { limit });

/** Mirrors `admin::DeletedView`. */
export interface DeletedAgent {
  id: string;
  name: string;
  role: string;
  color: string;
  deletedAt: number;
  restorableUntil: number;
  deletedBy?: AgentRef;
}

export const recentlyDeleted = () => invoke<DeletedAgent[]>('agents_recently_deleted');

export const restoreAgent = (agentId: string) => invoke<Agent>('agents_restore', { agentId });

/** "Restorable for 12 more days", "Restorable until tomorrow". */
export function restorableLine(until: number, now = Date.now()): string {
  const days = Math.ceil((until - now) / 86_400_000);
  if (days <= 0) return 'Removed for good soon';
  if (days === 1) return 'Restorable until tomorrow';
  return `Restorable for ${days} more days`;
}
