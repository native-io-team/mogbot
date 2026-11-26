/**
 * The Agents sidebar's states, one scenario each (light and dark come from
 * `--theme`): every kind of row, Catch up at its counts, narrow, the collapsed
 * rail and the first run. Built on the Agents team fixture (`./agents`).
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, TEAM, agent, messagesFor, overview, status } from './agents';

const NARROW_STEPS = [
  { focus: '[aria-label="Resize Project Sidebar"]' },
  ...Array.from({ length: 12 }, () => ({ key: 'ArrowLeft' })),
];

/** `n` agents waiting on the user, after the Chief. */
function waiting(n: number) {
  return [
    TEAM[0],
    ...Array.from({ length: n }, (_, i) =>
      agent(`wait${i}`, `Agent ${i + 1}`, {
        minutesAgo: 5 + i,
        status: status('waiting', 'Waiting for your OK'),
        pendingApprovals: 1,
        preview: 'Needs your OK',
      })
    ),
  ];
}

function sidebar(
  id: string,
  title: string,
  looksRightWhen: string,
  agents: unknown[] = TEAM,
  extra: Partial<Scenario> = {}
): Scenario {
  return {
    id,
    title,
    looksRightWhen,
    openSelector: AGENTS_TAB,
    requires: '.agents-list',
    clipSelector: '.workspace-sidebar',
    viewport: { width: 1100, height: 720 },
    commands: { agents_overview: overview(agents as typeof TEAM), agents_messages: messagesFor },
    ...extra,
  };
}

export const agentsSidebarStatesScenarios: Scenario[] = [
  sidebar(
    'agents-sidebar-rows',
    'Agents sidebar — every kind of row',
    'Catch up with “1 needs you” and the first names. The Chief and Native App pinned (small pin), Lead Gen with the amber “Needs your OK” tag alone (no excerpt), Acme Site with a 6px grey dot and its step, its clock (“2m”) in the time column, Finance with the blue unread dot under its time, Social Posts muted (bell-off mark), Hidden (1) folded like a folder header. The open row is the selected fill; nothing is accent-coloured.'
  ),
  sidebar(
    'agents-sidebar-catchup-clear',
    'Agents sidebar — nothing needs you',
    'Catch up says “All clear” in muted text, with no tag. No row carries an amber tag.',
    TEAM.map((a) => ({
      ...a,
      pendingApprovals: 0,
      status: a.status.state === 'waiting' ? status('idle') : a.status,
    }))
  ),
  sidebar(
    'agents-sidebar-catchup-twelve',
    'Agents sidebar — twelve need you',
    'Catch up says “12 need you” in one amber tag, then the first agents’ names cut with an ellipsis. Each waiting row shows the tag alone.',
    waiting(12)
  ),
  sidebar(
    'agents-sidebar-catchup-many',
    'Agents sidebar — ninety-nine plus need you',
    'Catch up says “99+ need you” in one amber tag; the list scrolls and its rows stay 52px.',
    waiting(100)
  ),
  sidebar(
    'agents-sidebar-narrow',
    'Agents sidebar — narrower than 240px',
    'No excerpts: each row is a key, a name (cut with an ellipsis) and its time. Where something needs you the tag is an amber dot. The search field says “Search” with no shortcut chip, and “New agent” keeps its whole label (the folder and room halves are gone, they live in ⌘K and the list’s menu).',
    TEAM,
    { steps: NARROW_STEPS }
  ),
  sidebar(
    'agents-sidebar-rail',
    'Agents sidebar — collapsed to the rail',
    'Keys only. A Catch up tile at the top with an amber “1” on its corner; Lead Gen’s key with an amber dot, Finance’s with a blue unread dot; the foot is one usage icon.',
    TEAM,
    { steps: [{ click: '[aria-label="Hide sidebar"]' }] }
  ),
  sidebar(
    'agents-sidebar-rail-many',
    'Agents sidebar — the rail with ninety-nine plus waiting',
    'The Catch up tile’s badge reads “99+”, amber, and stays inside the rail.',
    waiting(100),
    { steps: [{ click: '[aria-label="Hide sidebar"]' }] }
  ),
  sidebar(
    'agents-sidebar-first-run',
    'Agents sidebar — first run, only the Chief',
    'The Chief’s row reads “Hi. Tell me what you want to get done.”; Catch up says “All clear”. Centred under it: “Your team starts here”, “Ask the Chief for a first agent, or make one yourself.” and one strong “New agent” button.',
    [{ ...TEAM[0], preview: null, pendingApprovals: 0 }]
  ),
];
