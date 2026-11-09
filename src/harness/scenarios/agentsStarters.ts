/**
 * A new agent's first open (`agents/starters.rs`): its stored welcome, then
 * three tasks chosen from what it can already reach. Gmail isn't connected,
 * so one of the three is the ask to connect it; the others need nothing it
 * lacks. Built on the base layer's fresh Chief (`./base`).
 */

import type { Scenario } from '../types';
import { baseCommands, chiefGreeting } from './base';
import { agent, MIN, now } from './agents';

const BASE_OVERVIEW = baseCommands.agents_overview as {
  agents: Record<string, unknown>[];
};
const CHIEF = BASE_OVERVIEW.agents[0];

const INBOX = agent('inbox', 'Inbox', {
  role: 'Goes through your email and tells you what needs you.',
  color: 'teal',
  shape: 3,
  sessionId: null,
  minutesAgo: 0,
  starters: [
    { text: 'Help me connect Gmail', connect: 'Gmail' },
    { text: 'Plan my week with me' },
    { text: 'What do you need from me to start?' },
  ],
});

const WELCOME = {
  id: 'w1',
  agentId: 'inbox',
  ts: now - MIN / 2,
  kind: 'agent',
  text: 'I’m Inbox. I go through your mail each morning and tell you what needs you, what can wait and what’s noise.',
};

export const agentsStartersScenarios: Scenario[] = [
  {
    id: 'agents-new-agent-first-open',
    title: 'Agents — a new agent’s first open: its welcome and three starters',
    looksRightWhen:
      'Inbox’s chat: one welcome bubble in its own voice (“I’m Inbox. I go through your mail…”), and right under it three quiet outline buttons: “Help me connect Gmail”, “Plan my week with me”, “What do you need from me to start?”. Nothing in the accent but the badge; no generic “What’s on your plate?” chips. Clicking one sends it as your message.',
    command: 'agents.open',
    steps: [{ click: '[data-agent-id="inbox"]' }],
    requires: '[data-first-open]',
    commands: {
      agents_overview: { ...BASE_OVERVIEW, agents: [CHIEF, INBOX] },
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'inbox' ? [WELCOME] : [chiefGreeting('chief')],
    },
  },
];
