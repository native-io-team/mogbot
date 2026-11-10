/**
 * When things go wrong (docs/internal/failure-states.md): a turn whose
 * engine isn't on this Mac any more, the network gone, a turn cut off by a
 * restart, and What's in flight with each kind at once. Every line is a
 * sentence the Mac writes (`agents/failure.rs`, `agents/runner.rs`); every
 * name is fictional.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, messagesFor, msg, overview, status } from './agents';

const MISSING =
  "Claude Code isn't on this Mac any more, or the app can't find it. Install it again, then send this again.";
const OFFLINE =
  "Claude Code couldn't reach Anthropic over the network. Retry once this Mac is back online.";
const INTERRUPTED =
  'Interrupted: the app closed while this agent was working, so the turn stopped part-way. Continue picks it up where it was.';
const SIGNED_OUT = 'Claude Code is signed out.';

const chat = (agentId: string, ask: string, text: string, kind: string) => [
  msg('user', ask, 4, { agentId }),
  msg('error', text, 3, { agentId, failure: { kind } }),
];

const CHATS: Record<string, unknown[]> = {
  finance: chat('finance', 'Send Northwind the firmer reminder.', MISSING, 'engine_missing'),
  leadgen: chat('leadgen', 'Pull this week’s inbound leads into the sheet.', OFFLINE, 'other'),
  hiring: chat('hiring', 'Send the offer letter to Priya.', INTERRUPTED, 'interrupted'),
  acme: chat('acme', 'Run the tests before you push.', SIGNED_OUT, 'signed_out'),
};

const FAILED: Record<string, { kind: string; preview: string }> = {
  finance: { kind: 'engine_missing', preview: MISSING },
  leadgen: { kind: 'other', preview: OFFLINE },
  hiring: { kind: 'interrupted', preview: INTERRUPTED },
  acme: { kind: 'signed_out', preview: SIGNED_OUT },
};

/** Four agents, each stopped a different way. */
const failingTeam = () => {
  const base = overview();
  return {
    ...base,
    agents: TEAM.map((a) =>
      FAILED[a.id]
        ? {
            ...a,
            unread: 0,
            pendingApprovals: 0,
            status: status('idle'),
            preview: FAILED[a.id].preview,
            failure: { kind: FAILED[a.id].kind },
          }
        : a
    ),
  };
};

const messages = (args: Record<string, unknown>) =>
  CHATS[args.agentId as string] ?? messagesFor(args);

const commands = { agents_overview: failingTeam, agents_messages: messages };

export const agentsFailureScenarios: Scenario[] = [
  {
    id: 'agents-failure-engine-missing',
    title: 'Agents — its engine isn’t on this Mac any more',
    looksRightWhen:
      'Finance’s chat ends on a red card: “Claude Code isn’t on this Mac any more, or the app can’t find it. Install it again, then send this again.” with “Install Claude Code” and a quieter Retry. No os error, no path. Finance’s sidebar row reads “Not installed” as a red pill, then “Claude Code”.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    requires: '[data-failure="engine_missing"] [data-fix="install"]',
    commands,
  },
  {
    id: 'agents-failure-offline',
    title: 'Agents — the network went while a turn ran',
    looksRightWhen:
      'Lead Gen’s chat ends on a red card: “Claude Code couldn’t reach Anthropic over the network. Retry once this Mac is back online.” with Retry. No “ENOTFOUND”, no “fetch failed”, no URL.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="leadgen"]' }],
    requires: '[data-failure="other"]',
    commands,
  },
  {
    id: 'agents-failure-interrupted',
    title: 'Agents — a turn the app closing cut off',
    looksRightWhen:
      'Hiring’s chat ends on a red card, “Interrupted: the app closed while this agent was working…”, with one button, Continue (never Retry: sending the request again could do the work twice).',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="hiring"]' }],
    requires: '[data-failure="interrupted"]',
    commands,
  },
  {
    id: 'agents-team-failure-kinds',
    title: 'Agents — What’s in flight with every kind of failure',
    looksRightWhen:
      'Opened from ⌘K. Needs you lists four agents, each pill saying what happened once: Acme Site “Signed out · Claude Code”, Finance “Not installed · Claude Code”, Lead Gen “Didn’t finish · Claude Code couldn’t reach Anthropic over the network”, Hiring “Interrupted · Continue to pick it up”. Opening a row folds out its card with its one fix (Sign in to Claude Code, Install Claude Code, Retry, Continue; Continue sends “Continue”, never the request again). No row repeats its state in its reason.',
    command: 'agents.team',
    requires: '.agents-team',
    commands,
  },
];
