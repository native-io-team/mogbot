import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ModalProvider } from '../../contexts/ModalContext';
import { AgentEditorModal } from './AgentEditorModal';
import type { EngineInfo } from '../../lib/agents';
import { needsLine, ROLE_TEMPLATES, templateOf } from '../../lib/agentTemplates';
import { AGENT_COLORS } from '../../lib/agents';

const store = vi.hoisted(() => ({ engines: [] as EngineInfo[] }));
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  subscribeAgents: () => () => undefined,
  useAgentsSelector: <T,>(select: (s: { engines: EngineInfo[] }) => T) => select(store),
}));

const CLAUDE: EngineInfo = {
  id: 'claude',
  label: 'Claude Code',
  installed: true,
  signedIn: true,
  asks: true,
  models: [{ value: 'opus', label: 'Opus' }],
};

afterEach(() => clearMocks());

const brief = () => screen.getByPlaceholderText(/Brief it like a new hire/);

function openOn(template: string | null, onOpenApps = vi.fn()) {
  store.engines = [CLAUDE];
  const created: Record<string, unknown>[] = [];
  mockIPC((cmd, args) => {
    if (cmd === 'agents_create') {
      created.push((args as { input: Record<string, unknown> }).input);
      return { id: 'new' };
    }
    return cmd === 'list_projects' ? [] : null;
  });
  render(
    <ModalProvider>
      <AgentEditorModal
        isOpen
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onOpenApps={onOpenApps}
        initialTemplate={template}
        takenColors={['white']}
      />
    </ModalProvider>
  );
  return { created, onOpenApps };
}

async function create() {
  await act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    return Promise.resolve();
  });
}

describe('ready-made agents: the catalogue', () => {
  it('is the backend’s own file, and every entry is usable here', () => {
    expect(ROLE_TEMPLATES.map((t) => t.id)).toEqual(['research', 'inbox', 'weekly-review']);
    for (const t of ROLE_TEMPLATES) {
      expect(AGENT_COLORS).toContain(t.color);
      expect(t.starters.length).toBeGreaterThan(0);
    }
    expect(templateOf({ template: 'inbox' })?.name).toBe('Inbox');
    expect(templateOf({ template: 'gone' })).toBeNull();
    expect(templateOf({})).toBeNull();
  });

  it('only an inbox says it needs anything, and never whether it is connected', () => {
    const lines = ROLE_TEMPLATES.map((t) => needsLine(t, 'claude'));
    expect(lines.filter(Boolean)).toHaveLength(1);
    const inbox = ROLE_TEMPLATES.find((t) => t.id === 'inbox')!;
    expect(needsLine(inbox, 'codex')).toMatch(/connected in Codex/);
    expect(lines.join(' ')).not.toMatch(/not connected|is connected/i);
  });
});

describe('AgentEditorModal: starting from a ready-made agent', () => {
  it('fills in the briefing it will get, and marks the agent with its template', async () => {
    const { created } = openOn('research');
    expect(screen.getByLabelText('Agent name')).toHaveValue('Research');
    expect((brief() as HTMLTextAreaElement).value).toContain('Never invent a source');
    await create();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ name: 'Research', color: 'blue', template: 'research' });
  });

  it('swaps only what the last template filled in, never what was typed', () => {
    openOn('research');
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Scout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weekly Review' }));
    expect(screen.getByLabelText('Agent name')).toHaveValue('Scout');
    expect((brief() as HTMLTextAreaElement).value).toContain('weekly review');
    fireEvent.click(screen.getByRole('button', { name: 'Blank' }));
    expect(brief()).toHaveValue('');
  });

  it('says an inbox needs an email app, with the way to connect one', () => {
    const { onOpenApps } = openOn('inbox');
    expect(screen.getByText(/reads your email through an app you connect/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect an app…' }));
    expect(onOpenApps).toHaveBeenCalled();
  });

  it('creating blank sends no template', async () => {
    const { created } = openOn(null);
    // New agent opens on describing; the form is one quiet link away.
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'fill it in yourself' }));
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Finance' } });
    await create();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).not.toHaveProperty('template');
  });
});
