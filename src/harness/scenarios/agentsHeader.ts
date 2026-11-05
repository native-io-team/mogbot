/**
 * The conversation header at the widths where it used to collide: the
 * description ran under "N scheduled". Built on the Agents team fixture
 * (`./agents`); every name and routine here is fictional.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, messagesFor, now, overview, status } from './agents';

const ROUTINES = [
  {
    id: 'hdr1',
    note: 'Brief me on what came in overnight.',
    repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
    nextAt: now + 12 * 60 * MIN,
    createdAt: now - 7 * 24 * 60 * MIN,
    paused: false,
  },
  {
    id: 'hdr2',
    note: 'Check the team’s open threads before the weekend.',
    repeat: { kind: 'days', days: [5], hour: 16, minute: 0 },
    nextAt: now + 3 * 24 * 60 * MIN,
    createdAt: now - 14 * 24 * 60 * MIN,
    paused: false,
  },
];

const chiefWith = (extra: Record<string, unknown>) =>
  overview(TEAM.map((a) => (a.id === 'chief' ? { ...a, ...extra } : a)));

const SCHEDULED = chiefWith({ checkIns: ROUTINES });
const RUNNING = chiefWith({
  checkIns: ROUTINES,
  status: status('working', 'Asking Finance about the Northwind invoice'),
});

const openChief = { click: '[data-agent-id="chief"]' };
const commands = (agents_overview: unknown) => ({ agents_overview, agents_messages: messagesFor });

const at = (
  id: string,
  width: number,
  looksRightWhen: string,
  agents_overview: unknown = SCHEDULED
): Scenario => ({
  id,
  title: `Agents — chat header at ${width}px`,
  looksRightWhen,
  viewport: { width, height: 800 },
  openSelector: AGENTS_TAB,
  steps: [openChief],
  requires: '.agent-chat__header .agent-chat__scheduled',
  commands: commands(agents_overview),
});

export const agentsHeaderScenarios: Scenario[] = [
  at(
    'agents-header-wide',
    1440,
    'Chief of Staff’s header: avatar, name and the whole description centred; “2 scheduled” and the … menu at the trailing edge, clear of the text.'
  ),
  at(
    'agents-header-1100',
    1100,
    'The description is whole, or ends in an ellipsis before “2 scheduled”, never under it; the clock, “2 scheduled” and … keep their size and spacing.'
  ),
  at(
    'agents-header-760',
    760,
    'Narrowest with the sidebar: the description is gone (it stays in the tooltip), the name whole, “2 scheduled” and … at the trailing edge.'
  ),
  at(
    'agents-header-900',
    900,
    'Narrower: the title slides left of centre rather than meet the actions; the description truncates with an ellipsis if it must, never under “2 scheduled”.'
  ),
  at(
    'agents-header-running',
    1100,
    'Same as at 1100px while the Chief is working: the description truncates before the actions; nothing overlaps.',
    RUNNING
  ),
  {
    id: 'agents-header-compact',
    title: 'Agents — chat header, compact window',
    looksRightWhen:
      'No sidebar: the mode toggle at the leading edge, the agent switcher, and at the trailing edge “2” with its clock and the … menu. Nothing overlaps.',
    viewport: { width: 520, height: 800 },
    command: 'agents.open',
    requires: '.agent-chat__header .agent-chat__scheduled',
    commands: commands(SCHEDULED),
  },
  {
    id: 'agents-header-narrowest',
    title: 'Agents — chat header, narrowest window',
    looksRightWhen:
      'The scheduled button keeps only its clock and “2” (hovering says “2 scheduled routines”); the switcher’s name truncates before it if it must. Nothing overlaps.',
    viewport: { width: 400, height: 800 },
    command: 'agents.open',
    requires: '.agent-chat__header .agent-chat__scheduled',
    commands: commands(SCHEDULED),
  },
];
