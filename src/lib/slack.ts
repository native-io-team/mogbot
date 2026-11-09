/**
 * Slack: start your agents from a Slack message and get the answer in the
 * thread (`src-tauri/src/agents/slack.rs`). This Mac reads the conversations
 * the user picks; nothing runs on a server. Types mirroring the Rust status,
 * the invoke wrappers, and the Settings words.
 *
 * The token goes from the masked field to the Keychain in one call
 * (`connectSlack`); no call ever returns it.
 *
 * @module lib/slack
 */

import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

export const SLACK_EVENT = 'agents-slack';

export type SlackConversationKind = 'self' | 'im' | 'group' | 'channel' | 'private';

export interface SlackConversation {
  id: string;
  /** A `SlackConversationKind`, or one a newer Mac knows. */
  kind: string;
  /** "#launch", "Sam", "Your own DM". */
  name: string;
}

export interface SlackStatus {
  connected: boolean;
  team?: string | null;
  user?: string | null;
  enabled: boolean;
  needsSignIn: boolean;
  /** Who answers; absent until connected. */
  agentId?: string | null;
  agentName?: string | null;
  conversations: SlackConversation[];
  trigger: string;
  defaultTrigger: string;
  othersCanStart: boolean;
  lastCheckAt?: number | null;
  lastError?: string | null;
  /** Asks whose answer hasn't gone back yet. */
  waiting: number;
  /** Slack's "create an app from a manifest" page, prefilled. */
  setupUrl: string;
  /** Only on Disconnect's answer: whether Slack signed the token out too. */
  disconnected?: string | null;
}

export interface SlackPatch {
  enabled?: boolean;
  /** `null`: back to the Chief of Staff. */
  agentId?: string | null;
  conversations?: SlackConversation[];
  trigger?: string;
  othersCanStart?: boolean;
}

export const getSlackStatus = () => invoke<SlackStatus>('agents_slack_status');
export const connectSlack = (token: string) =>
  invoke<SlackStatus>('agents_slack_connect', { token });
export const listSlackConversations = () =>
  invoke<SlackConversation[]>('agents_slack_conversations');
export const updateSlack = (patch: SlackPatch) =>
  invoke<SlackStatus>('agents_slack_update', { patch });
export const checkSlackNow = () => invoke<SlackStatus>('agents_slack_check_now');
export const disconnectSlack = () => invoke<SlackStatus>('agents_slack_disconnect');
export const openSlackSetup = (s: SlackStatus) => openUrl(s.setupUrl);

/* ------------------------------------------------------------- the words */

export const SLACK_TITLE = 'Slack';

/** The line under the switch. */
export function slackLine(s: SlackStatus | null, now = Date.now()): string {
  if (!s?.connected) {
    return 'Start your agents from a Slack message and get the answer in the thread. This Mac reads Slack; nothing runs on a server.';
  }
  const who = [s.team, s.user].filter(Boolean).join(' as ');
  if (s.needsSignIn) {
    return `Slack refused the sign-in${who ? ` for ${who}` : ''}. Paste a new token below.`;
  }
  if (!s.enabled) return `Connected${who ? ` to ${who}` : ''}. Off: nothing is read.`;
  if (s.lastError)
    return `On, but the last check didn’t work: ${s.lastError.replace(/[.!]+$/, '')}.`;
  const checked = s.lastCheckAt ? ` Checked ${checkedWhen(s.lastCheckAt, now)}.` : '';
  return `On${who ? ` in ${who}` : ''}.${checked}`;
}

function checkedWhen(at: number, now: number): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** "Your own DM, #launch and 2 more". */
export function whereLine(conversations: SlackConversation[]): string {
  if (conversations.length === 0) return 'Nowhere yet. Choose a DM or channel.';
  const names = conversations.map((c) => c.name);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** What a Slack-originated chat line is labelled with: "From Slack · #launch" (worded once, with the phone). */
export { viaLabel } from '../../packages/companion-protocol/src/model';
