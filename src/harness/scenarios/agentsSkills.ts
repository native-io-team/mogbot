/**
 * Skills an agent saved after a hard task (`agents/skills_learn.rs`): the
 * "Save “…” as a skill?" card in its chat (pending, saved, and one from a
 * conversation that read outside content), and Edit agent's "Save what it
 * learns" with "Skills". Shapes copied from the Rust serde
 * output (`fixtures.gen.ts` has `agentsSkills`).
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, messagesFor, msg, overview, TEAM } from './agents';

const SKILL = {
  slug: 'reconcile-stripe-payouts',
  name: 'Reconcile Stripe payouts',
  when: 'When the user asks to reconcile last month’s payouts against the ledger',
  steps:
    '1. Export last month’s payouts from Stripe (Balance → Payouts → Export, CSV).\n2. Open the ledger sheet’s “Payouts” tab and paste the export below the last row.\n3. Match each payout to its bank line by amount and date (±2 days).\n4. List anything unmatched in a table and share it as a result card.',
};

const card = (status: 'pending' | 'allowed', outside = false) =>
  msg('approval', '', 1, {
    agentId: 'finance',
    approval: {
      requestId: outside ? 'skill-out' : 'skill-1',
      title: `Save “${SKILL.name}” as a skill?`,
      detail: SKILL.steps,
      summary: `When to use it: ${SKILL.when} 1 personal detail or secret removed.`,
      status,
      risk: outside ? 'high' : 'low',
      skill: { ...SKILL, removed: 1, ...(outside ? { outside: true } : {}) },
    },
  });

const chat =
  (status: 'pending' | 'allowed', outside = false) =>
  (args: Record<string, unknown>) =>
    args.agentId === 'finance'
      ? [
          msg('user', 'Reconcile October’s Stripe payouts against the ledger.', 9, {
            agentId: 'finance',
          }),
          msg(
            'agent',
            'Done: 41 of 43 payouts match. Two don’t, both on Oct 14; they’re in the table above. I’ve offered to keep how I did it as a skill.',
            2,
            { agentId: 'finance' }
          ),
          card(status, outside),
          ...(status === 'allowed'
            ? [
                msg(
                  'note',
                  'Saved a skill: Reconcile Stripe payouts. Next time it follows these steps.',
                  0,
                  { agentId: 'finance' }
                ),
              ]
            : []),
        ]
      : messagesFor(args);

// A skill card is an offer: the registry never counts it as waiting on you
// (`store::count_pending`), so Finance's row carries no "Needs your OK".
const FINANCE_PENDING = TEAM;

export const agentsSkillsScenarios: Scenario[] = [
  {
    id: 'agents-skill-card',
    title: 'Agents — “Save … as a skill?” after a hard task',
    looksRightWhen:
      'Finance’s chat: the user’s ask, Finance’s reply, then one card “Save “Reconcile Stripe payouts” as a skill?” with a graduation-cap icon, when to use it in plain text, the four numbered steps under it, a muted “1 personal detail or secret removed.”, and a muted note that nothing waits on it. Drawn as an offer, not a gate: no raised surface (a faint hairline), the title a step quieter, Not now plain and Save outlined, never solid or the accent; no A / D key hints. No “More answers” menu, no Always allow.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    requires: '.agent-skill-card__steps',
    clipSelector: '.agent-approval',
    commands: {
      agents_overview: overview(FINANCE_PENDING),
      agents_messages: chat('pending'),
    },
  },
  {
    id: 'agents-skill-card-saved',
    title: 'Agents — a skill card once saved',
    looksRightWhen:
      'The card folded to one quiet line, “Saved · under Skills”, and under it the line “Saved a skill: Reconcile Stripe payouts. Next time it follows these steps.” No buttons.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    requires: '.agent-chat__row--card',
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: chat('allowed'),
    },
  },
  {
    id: 'agents-skill-card-outside',
    title: 'Agents — a skill from a conversation that read outside content',
    looksRightWhen:
      'The same card with the warning icon and tone (it read outside content, so it asks whatever the setting), and its small print ends “It read outside content in this conversation: check nothing in it came from there.” Save is the danger style only by icon and tone, never the accent.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="finance"]' }],
    requires: '.agent-skill-card__note',
    clipSelector: '.agent-approval',
    commands: {
      agents_overview: overview(FINANCE_PENDING),
      agents_messages: chat('pending', true),
    },
  },
  {
    id: 'agents-editor-skills',
    title: 'Agents — Edit agent: Save new skills, and Skills',
    looksRightWhen:
      'Finance’s Skills page, opened in place from Edit agent (‹ Edit agent in the bar): “Save new skills” with a three-way control (Automatically, Ask me, Off) on Ask me, the line “After a hard task it offers to save how it did it, on a card. Anything that read outside content asks first.”, then “Skills” listing “Reconcile Stripe payouts” with when to use it muted under it, and quiet Edit and Remove at the right.',
    openSelector: AGENTS_TAB,
    requires: '.agent-skills__skill',
    clipSelector: '.agent-skills',
    steps: [
      { click: '[data-agent-id="finance"]' },
      { click: '.agent-chat__menu [aria-label^="Actions for"]' },
      { click: '[role="menuitem"]', text: 'Edit agent' },
      { click: '.agent-sheet__nav-row', text: 'Skills' },
    ],
    commands: {
      agents_overview: overview(TEAM),
      agents_messages: messagesFor,
      agents_instructions: 'Keeps the books.',
      agents_skills: { agentId: 'finance', setting: 'ask', skills: [SKILL] },
    },
  },
];
