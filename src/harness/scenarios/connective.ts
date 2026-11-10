/**
 * The desk's connective tissue: the ⌘K palette (opened, typed into, nothing
 * found, inside a project) and the toast stack. Each is reached the way a
 * person reaches it, with ⌘K, so the captures are of the real surface.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, overview } from './agents';
import { WORKSPACE_PROJECT, workspaceCommands } from './workspace';
import { rejectsWith } from '../reject';

const commands = { agents_overview: overview() };

export const connectiveScenarios: Scenario[] = [
  {
    id: 'palette-open',
    title: '⌘K — opened on Agents, nothing typed',
    looksRightWhen:
      'The palette top-anchored over Agents: the search field, the category tabs, then the commands grouped with Agents first. Every row has an icon; no group is empty; the footer names the keys.',
    requires: '.command-palette-row',
    openSelector: AGENTS_TAB,
    steps: [{ key: 'mod+k' }],
    commands,
  },
  {
    id: 'palette-query',
    title: '⌘K — “agent” typed',
    looksRightWhen:
      'Rows whose title starts with or has a word starting with “agent” first, grouped under their headers; the best hit selected.',
    requires: '.command-palette-row.is-selected',
    openSelector: AGENTS_TAB,
    steps: [{ key: 'mod+k' }, { fill: '.command-palette-input', value: 'agent' }],
    commands,
  },
  {
    id: 'palette-no-match',
    title: '⌘K — nothing matches',
    looksRightWhen:
      'One quiet line saying nothing matched, and the way on from here: asking the Chief of Staff with what was typed. No blank list.',
    requires: '.command-palette-empty',
    openSelector: AGENTS_TAB,
    steps: [{ key: 'mod+k' }, { fill: '.command-palette-input', value: 'quarterly invoices' }],
    commands,
  },
  {
    id: 'palette-project',
    title: '⌘K — inside a project',
    looksRightWhen:
      'The palette over a project’s workspace: the scope line names the project, the tabs include Branches, the project’s own actions come first.',
    project: WORKSPACE_PROJECT,
    requires: '.command-palette-row',
    steps: [{ hover: '.workspace-body .mode-toggle' }, { key: 'mod+k' }],
    commands: { ...workspaceCommands },
  },
  {
    id: 'toast-success',
    title: 'Toast — Open logs says where it opened',
    looksRightWhen:
      'One toast, top right, under the chat header (Schedule, Model and ⋯ uncovered): a tick, one sentence, a close button. Exactly one toast is drawn, not two stacked on each other.',
    requires: '.toast',
    command: 'agents.openLogs',
    commands: { ...commands, agents_open_logs: '/Users/sam/Library/Logs/Mogbot' },
  },
  {
    id: 'toast-error-repeated',
    title: 'Toast — the same failure twice',
    looksRightWhen:
      'One toast under the chat header: the failure with a red error mark (not the info “i”), “×2” after its sentence, then Copy and close. No second copy of it stacked underneath.',
    requires: '.toast-error .toast-count',
    openSelector: AGENTS_TAB,
    steps: [
      { key: 'mod+k' },
      { fill: '.command-palette-input', value: 'Open logs' },
      { click: '.command-palette [role="option"]', text: 'Open logs' },
      { key: 'mod+k' },
      { fill: '.command-palette-input', value: 'Open logs' },
      { click: '.command-palette [role="option"]', text: 'Open logs' },
    ],
    commands: { ...commands, agents_open_logs: rejectsWith('Finder is not responding.') },
  },
];
