/**
 * First run's "bring your agents over", as a conversation with the Chief
 * (`components/agents/ImportGuide.tsx`, `agents::guide`): the ask under the
 * greeting, then one Chief message per step with that step's one action,
 * steps behind it reading Done.
 */

import type { Scenario } from '../types';
import { baseCommands, chiefGreeting } from './base';
import { remoteStatus } from './remote';
import { MIN, now } from './agents';

const BASE_OVERVIEW = baseCommands.agents_overview as Record<string, unknown>;
const BRINGING = { ...BASE_OVERVIEW, importChoice: 'bringing' };

const TS = { state: 'connected', dnsName: 'studio-mac.tail1234.ts.net', login: 'you@example.com' };
const LINK_ON = {
  enabled: true,
  serverRunning: true,
  tailscale: TS,
  funnelOn: true,
  linkMasked: 'https://studio-mac.tail1234.ts.net/mogbot/••••••••',
  reachability: { state: 'reachable' },
};

const WORDS: Record<string, string> = {
  tailscale:
    "Nice, let's bring them over. Grok needs a private way to reach me on this Mac, and that's a free app called Tailscale. Install it and sign in. I'll notice the moment it's on.",
  link: "Tailscale's on. Now I'll open a private link to me that only you hand out. Grok uses it to talk to me, and nobody else can.",
  connect:
    "My link is live. Now add me to Grok as a connector. It takes a minute, and I'll see it the moment Grok connects.",
  send: "Grok can reach me now. Last step: send Grok this message. When it says hello I'll ask you once, right here, before I listen. That's how I ask before anything that matters.",
};

const step = (id: string, minutesAgo: number) => ({
  id: `guide-${id}`,
  agentId: 'chief',
  // Older than an hour: shown as history, not typed out (`useStreamIn`).
  ts: now - (90 + minutesAgo) * MIN,
  kind: 'agent' as const,
  text: WORDS[id],
  blocks: {
    v: 1,
    intro: WORDS[id],
    items: [{ kind: 'guide', summary: 'On your Mac.', step: id, assistant: 'grok' }],
  },
});

const picked = [
  chiefGreeting('chief', now - 99 * MIN),
  { id: 'pick', agentId: 'chief', ts: now - 98 * MIN, kind: 'user' as const, text: 'Grok' },
];

const guideCommands = (steps: string[], status: Record<string, unknown>) => ({
  agents_overview: BRINGING,
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'chief' ? [...picked, ...steps.map((s, i) => step(s, 7 - i))] : [],
  agents_guide_state: { assistant: 'grok', posted: steps, startedAt: now - 8 * MIN },
  agents_guide_post: false,
  get_remote_access_status: remoteStatus(status),
  set_remote_access_enabled: remoteStatus(LINK_ON),
  copy_remote_link: null,
});

export const agentsGuideScenarios: Scenario[] = [
  {
    id: 'agents-guide-tailscale',
    title: 'Agents — bringing agents over, step 1: Tailscale, in the Chief’s chat',
    looksRightWhen:
      'The greeting, the user’s own “Grok” on the right, then the Chief saying why Tailscale and that it will notice by itself. Under its words one neutral “Get Tailscale” button and a quiet “Waiting for Tailscale…” line. No modal, no checklist, no link shown.',
    command: 'agents.open',
    requires: '.agent-guide-step',
    commands: guideCommands(['tailscale'], {}),
  },
  {
    id: 'agents-guide-connect',
    title: 'Agents — bringing agents over: add the link to Grok',
    looksRightWhen:
      'Earlier steps read “Done. Tailscale is on.” and “Done. Your link is on.” as quiet lines. The latest Chief message says to add it to Grok, then Grok’s three short steps, “Copy my link” and “Open Grok”, and “Waiting for Grok to connect…”. The link itself never appears.',
    command: 'agents.open',
    requires: '.agent-guide-step__list',
    commands: guideCommands(['tailscale', 'link', 'connect'], LINK_ON),
  },
  {
    id: 'agents-guide-send',
    title: 'Agents — bringing agents over: the message to send Grok',
    looksRightWhen:
      'Every earlier step reads Done. The last Chief message says this is the last step and that it will ask once before it listens; under it the message to send in a box with Copy, and “Waiting for Grok to say hello…”.',
    command: 'agents.open',
    requires: '.agent-guide-step',
    commands: guideCommands(['tailscale', 'link', 'connect', 'send'], {
      ...LINK_ON,
      everConnected: true,
      activity: { lastRequestMs: now - MIN, lastClient: 'Grok', rejectedRequests: 0 },
    }),
  },
  {
    id: 'agents-first-run-fresh',
    title: 'Agents — first run: “I’m starting fresh”, then the starters',
    looksRightWhen:
      'The greeting, the user’s own “I’m starting fresh” on the right, then the Chief: “Okay! What do you want me to do?” with its four starters and More ideas… under it. No import question any more.',
    command: 'agents.open',
    requires: '.agent-chat__starters',
    commands: {
      agents_overview: { ...BASE_OVERVIEW, importChoice: 'declined' },
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief'
          ? [
              chiefGreeting('chief', now - 99 * MIN),
              {
                id: 'fresh-pick',
                agentId: 'chief',
                ts: now - 98 * MIN,
                kind: 'user' as const,
                text: 'I’m starting fresh',
              },
              {
                id: 'fresh-ask',
                agentId: 'chief',
                ts: now - 97 * MIN,
                kind: 'agent' as const,
                text: 'Okay! What do you want me to do?',
                blocks: {
                  v: 1,
                  intro: 'Okay! What do you want me to do?',
                  items: [{ kind: 'guide', summary: '', step: 'fresh', assistant: 'other' }],
                },
              },
            ]
          : [],
    },
  },
  {
    id: 'agents-first-run-streaming',
    title: 'Agents — first run: the greeting types itself out',
    looksRightWhen:
      'Caught mid-way: the Chief’s greeting part-written (or its typing dots), nothing under it yet. The “Already have agents somewhere else?” question follows once the greeting is done, then its buttons.',
    command: 'agents.open',
    requires: '[data-stream-in]',
    commands: {
      agents_overview: { ...BASE_OVERVIEW, importChoice: 'undecided' },
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'chief' ? [chiefGreeting('chief', Date.now())] : [],
    },
  },
];
