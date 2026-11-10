/**
 * The desk's connective tissue: the ⌘K palette (opened, typed into, nothing
 * found, inside a project) and the toast stack. Each is reached the way a
 * person reaches it, with ⌘K, so the captures are of the real surface.
 */

import type { Scenario } from '../types';
import { AGENTS_TAB, overview } from './agents';
import { WORKSPACE_PROJECT, workspaceCommands } from './workspace';

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
      'One toast, top right, under the window’s edge: a tick, one sentence, a close button. Exactly one toast is drawn, not two stacked on each other.',
    requires: '.toast',
    command: 'agents.openLogs',
    commands: { ...commands, agents_open_logs: '/Users/sam/Library/Logs/Mogbot' },
  },
];
