import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ModalProvider } from '../../contexts/ModalContext';
import { AgentEditorModal } from './AgentEditorModal';
import type { EngineInfo } from '../../lib/agents';

const store = vi.hoisted(() => ({ engines: [] as EngineInfo[] }));
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  // Nothing to listen to: the store here is `store`, set per test.
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
const CODEX: EngineInfo = {
  id: 'codex',
  label: 'Codex',
  installed: true,
  signedIn: true,
  asks: true,
  models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
};

afterEach(() => clearMocks());

function open(engines: EngineInfo[], onSetUpEngine = vi.fn()) {
  store.engines = engines;
  const created: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === 'agents_create') {
      created.push((args as { input: unknown }).input);
      return { id: 'new' };
    }
    if (cmd === 'list_projects') return [];
    return null;
  });
  render(
    <ModalProvider>
      <AgentEditorModal isOpen onClose={vi.fn()} onSaved={vi.fn()} onSetUpEngine={onSetUpEngine} />
    </ModalProvider>
  );
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Finance' } });
  return { created, onSetUpEngine };
}

async function create() {
  await act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    return Promise.resolve();
  });
}

describe('AgentEditorModal: what a new agent runs on', () => {
  it('puts a new agent on the engine that can run it, not one that isn’t installed', async () => {
    const { created } = open([{ ...CLAUDE, installed: false, signedIn: false }, CODEX]);
    // One engine installed: nothing to choose, and nothing greyed out.
    expect(screen.queryByRole('group', { name: 'Runs on' })).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-engine-protections')).toHaveTextContent(
      /can't reach the internet/
    );
    expect(screen.getByRole('button', { name: 'Also use Claude Code' })).toBeInTheDocument();
    await create();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ engine: 'codex' });
  });

  it('offers no choice to someone with one engine, only a quiet way to add the other', async () => {
    const { created, onSetUpEngine } = open([
      CLAUDE,
      { ...CODEX, installed: false, signedIn: false },
    ]);
    expect(screen.queryByRole('group', { name: 'Runs on' })).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't set up/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Also use Codex' }));
    expect(onSetUpEngine).toHaveBeenCalledWith('codex', 'install');
    await create();
    await waitFor(() => expect(created[0]).toMatchObject({ engine: 'claude' }));
  });

  it('shows the picker once both are installed, with the reason one can’t be chosen', () => {
    open([CLAUDE, { ...CODEX, signedIn: false }]);
    expect(screen.getAllByRole('group', { name: 'Runs on' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Codex' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText(/Codex isn't signed in\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in to Codex' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Also use/ })).not.toBeInTheDocument();
  });

  it('never leaves the chosen engine unavailable without saying why', () => {
    // Nothing is ready: it falls back to Claude Code, and says what it needs.
    open([
      { ...CLAUDE, installed: false, signedIn: false },
      { ...CODEX, installed: false, signedIn: false },
    ]);
    expect(screen.getByText(/Claude Code isn't set up yet\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up Claude Code' })).toBeInTheDocument();
  });
});
