/**
 * Everything at once. Each Agents feature has its own scenario; these put the
 * ones that can coexist on one screen — you driving the agent, an import going,
 * another agent's request, a nearly full conversation, a key in the draft —
 * so what's checked is whether they still read as one product: cards in the
 * conversation, one stack of bars above the composer, the header identity only.
 *
 * Also the per-agent palette: the commands that exist only with an agent
 * selected (Take over, Start fresh, Stop…), which the default-context palette
 * sweep never reaches.
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import {
  ACME_FULL,
  AGENTS_TAB,
  MIN,
  REVIEW,
  REVIEW_CARD,
  REVIEW_CHAT,
  TEAM,
  gateWith,
  messagesFor,
  now,
  overview,
} from './agents';
import { ACME_COPY_CHAT, copyTeam } from './agentsProject';

const ACME_PATH = `${HARNESS_ROOT}/acme-marketing`;

const drivenChief = {
  since: now - 6 * MIN,
  ptySession: 'takeover-chief',
  project: ACME_PATH,
  cli: 'claude-code',
};

/** The Chief: being driven or not, its conversation 87% full, a review waiting. */
const chiefTeam = (driven: boolean) =>
  overview(
    TEAM.map((a) =>
      a.id === 'chief'
        ? {
            ...a,
            ...ACME_FULL,
            pendingApprovals: 1,
            ...(driven ? { takeover: drivenChief } : {}),
          }
        : a
    )
  );

const chiefCommands = (driven: boolean) => ({
  agents_overview: chiefTeam(driven),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'chief' ? [...REVIEW_CHAT, REVIEW_CARD()] : messagesFor(args),
  agents_import_talk: gateWith({ state: 'review' }),
  agents_import_review_current: REVIEW,
  pty_session_attach: { buffer: [], pid: 1, alive: true, exitCode: null, endOffset: 0 },
  pty_session_detach: null,
  pty_session_resize: null,
  pty_session_write: null,
  pty_session_set_paused: null,
});

/** Acme Site driven in its own project, a copy of the project ready, 87% full. */
const acmeStackTeam = () =>
  overview(
    copyTeam().map((a) =>
      a.id === 'acme'
        ? {
            ...a,
            context: ACME_FULL.context,
            takeover: {
              since: now - 4 * MIN,
              ptySession: 'takeover-acme',
              project: ACME_PATH,
              cli: 'claude-code',
            },
          }
        : a
    )
  );

export const agentsStackScenarios: Scenario[] = [
  {
    id: 'agents-stack-chief',
    title: 'Agents — everything at once in the Chief’s chat, while you drive it',
    looksRightWhen:
      'The header is identity only: the Chief’s badge, name and role, no status. The conversation ends on the import review card (download icon, title, “From Grok”, rows with avatars and neutral chips, Don’t import and a neutral Import 2 agents on the right), then the one chip “Review Lead Gen’s request”. No “getting long” nudge: Start fresh can’t run while you drive. Above the composer, one stack in the reading column: first the take-over bar (terminal icon in the accent, “You’re driving Chief of Staff in acme-marketing”, Open in acme-marketing, Hand back), then the import bar (amber dot, “Import from Grok · ready to review”, Stop). Nothing full-width under the header. The sidebar row says “Needs your OK” with an amber dot (the request outranks driving).',
    command: 'agents.open',
    requires: '[data-bar="takeover"] .agent-bar',
    commands: chiefCommands(true),
  },
  {
    id: 'agents-stack-chief-free',
    title: 'Agents — everything at once in the Chief’s chat, not driven',
    looksRightWhen:
      'As agents-stack-chief without the take-over: the header identity only, the review card, the Lead Gen chip, then the quiet centred nudge “This conversation is getting long…” with its Start fresh link, wrapping rather than cut. One bar above the composer: the import’s.',
    command: 'agents.open',
    requires: '.agent-fresh-hint',
    commands: chiefCommands(false),
  },
  {
    id: 'agents-stack-bars',
    title: 'Agents — three bars at once fold to two',
    looksRightWhen:
      'The Chief, driven, with an import at review and a Stripe key typed in the composer: the take-over bar, then the import bar, and under them a quiet centred “1 more” (the secret hint, third in the fixed order). The composer is not pushed away.',
    command: 'agents.open',
    requires: '.agent-bars__more',
    steps: [
      { fill: '.agent-composer__input', value: 'Here it is: sk_live_51HxQ2bL9vT3kR8mN4pW7yZ0' },
    ],
    commands: chiefCommands(true),
  },
  {
    id: 'agents-stack-acme',
    title: 'Agents — Acme Site driven in its project, with changes ready',
    looksRightWhen:
      'Header: Acme Site’s badge, name, role and the “acme-marketing copy” chip, no status. The newest card “Changes are ready” (folder icon, “3 files”, the muted copy line) has its actions on the right: ⋯, Discard, Preview, Review changes, then Keep changes. Keep changes and Discard are disabled while you drive (hovering says hand it back first); Review changes and Preview still work. No “getting long” nudge. One bar above the composer: “You’re driving Acme Site in acme-marketing” with Open in acme-marketing and Hand back.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="acme"]' }],
    requires: '[data-bar="takeover"] .agent-bar',
    commands: {
      agents_overview: acmeStackTeam(),
      agents_messages: (args: Record<string, unknown>) =>
        args.agentId === 'acme' ? ACME_COPY_CHAT : messagesFor(args),
    },
  },
  {
    id: 'agents-palette-acme',
    title: 'Agents — ⌘K with Acme Site open',
    looksRightWhen:
      'The palette over Acme Site’s chat, searched for “take over”: one “Take over Acme Site” with a terminal icon, for the agent you’re looking at — not one line per agent.',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { key: 'mod+k' },
      { fill: '.command-palette-input', value: 'take over' },
    ],
    requires: '.command-palette',
    commands: {
      agents_overview: overview(copyTeam()),
      agents_messages: messagesFor,
    },
  },
  {
    id: 'agents-palette-acme-driven',
    title: 'Agents — ⌘K while you drive Acme Site',
    looksRightWhen:
      'The palette, searched for “hand”: “Hand Acme Site back” with a terminal icon. No “Take over” for it while it is already driven.',
    openSelector: AGENTS_TAB,
    steps: [
      { click: '[data-agent-id="acme"]' },
      { key: 'mod+k' },
      { fill: '.command-palette-input', value: 'hand' },
    ],
    requires: '.command-palette',
    commands: {
      agents_overview: acmeStackTeam(),
      agents_messages: messagesFor,
    },
  },
];
