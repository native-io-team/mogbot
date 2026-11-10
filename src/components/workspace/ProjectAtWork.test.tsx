/**
 * An agent at work in a codebase shows in the Projects sidebar: under the
 * project's row ("Juno · Running the build"), as its own row when the project
 * isn't pinned or open, and never for a turn the Mac didn't say was there.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeSidebar } from './HomeSidebar';
import { atWorkLines, projectAgentRows } from './useProjectAgents';
import { ModalProvider } from '../../contexts/ModalContext';
import { PaletteContextProvider } from '../CommandPalette/paletteContext';
import type { PinnedProjectRow } from '../../hooks/usePinnedProjects';
import type { Agent, AgentStatus } from '../../lib/agents';

const SITE = '/Users/sam/Desktop/Projects/lumen-site';
const ACME = '/Users/sam/ShipStudio/acme-marketing';

vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ activeAccount: null, accounts: [] }),
}));
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  useAgentsAttention: () => ({ waiting: [], unread: 0 }),
}));
const intents: unknown[] = [];
vi.mock('../../commands/useAgentsCommands', () => ({
  requestAgentsIntent: (intent: unknown) => intents.push(intent),
}));

let team: Agent[] = [];
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  getAgentsWithProjects: () => Promise.resolve(team),
}));

const agent = (
  id: string,
  name: string,
  state: AgentStatus['state'],
  project?: string,
  bound?: string
): Agent =>
  ({
    id,
    name,
    hidden: false,
    project: bound,
    pendingApprovals: 0,
    status: {
      state,
      activity: 'Running the build',
      since: 0,
      work:
        state === 'idle'
          ? undefined
          : {
              startedAt: 0,
              stepCount: 2,
              steps: [],
              fileCount: 0,
              project,
              current: {
                kind: 'command',
                label: 'Running the build',
                startedAt: 0,
                streams: false,
                canStop: false,
              },
            },
    },
  }) as unknown as Agent;

const row = (projectPath: string): PinnedProjectRow => ({
  projectPath,
  fallbackName: projectPath.split('/').pop()!,
  status: 'inactive',
  agentStatus: 'idle',
  unreadCount: 0,
  memoryBytes: 0,
  isCurrent: false,
});

const props = {
  activeNav: 'home' as const,
  onGoHome: vi.fn(),
  onGoProjects: vi.fn(),
  onGoAgents: vi.fn(),
  isSidebarHidden: false,
  onToggleSidebar: vi.fn(),
  onOpenProjectPicker: vi.fn(),
  projects: [] as PinnedProjectRow[],
  onSelectProject: vi.fn(),
  onCloseProject: vi.fn(),
  onSelectProjectTab: vi.fn(),
  isProjectDevServerRunning: () => false,
  onSwitchAccount: vi.fn(),
};

function renderSidebar(projects: PinnedProjectRow[]) {
  return render(
    <ModalProvider>
      <PaletteContextProvider>
        <HomeSidebar {...props} projects={projects} />
      </PaletteContextProvider>
    </ModalProvider>
  );
}

describe('agents at work in the Projects sidebar', () => {
  beforeEach(() => {
    intents.length = 0;
    vi.clearAllMocks();
  });

  it('collapsed, shows only a stack of avatars: no line, no step text', async () => {
    team = [agent('juno', 'Juno', 'working', SITE)];
    renderSidebar([row(SITE)]);
    expect(await screen.findByRole('img', { name: 'At work here: Juno' })).toBeInTheDocument();
    expect(screen.queryByText(/Running the build/)).not.toBeInTheDocument();
  });

  it('caps the stack at three and counts the rest', async () => {
    team = ['a', 'b', 'c', 'd', 'e'].map((id) => agent(id, id.toUpperCase(), 'working', SITE));
    renderSidebar([row(SITE)]);
    expect(await screen.findByText('+2')).toBeInTheDocument();
  });

  it("lists a project an agent is at work in even when it isn't pinned", async () => {
    team = [agent('juno', 'Juno', 'working', SITE)];
    renderSidebar([row(ACME)]);
    expect(await screen.findByText('lumen-site')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'At work here: Juno' })).toBeInTheDocument();
  });

  it('says nothing for an idle agent, or a turn working somewhere else', async () => {
    team = [agent('idle', 'Idle One', 'idle', undefined, SITE), agent('m', 'Mo', 'working', ACME)];
    renderSidebar([row(SITE)]);
    await screen.findByText('acme-marketing');
    expect(screen.queryByText('Idle One')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('img', { name: /At work here/ })).toHaveLength(1);
  });
});

describe('the open project lists who works here', () => {
  it('leaves agents at work to the sessions list, and lists the bound idle ones', () => {
    const team = [
      agent('b', 'Bound Idle', 'idle', undefined, SITE),
      agent('w', 'Worker', 'working', SITE),
      agent('x', 'Elsewhere', 'working', ACME),
    ];
    const rows = projectAgentRows(team, SITE, () => undefined, 0);
    expect(rows.map((r) => [r.label, r.meta])).toEqual([['Bound Idle', undefined]]);
    expect(atWorkLines(team, ACME, 0).map((l) => l.text)).toEqual(['Running the build']);
  });
});
