import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// Unmount first: the policy section's unlisten needs the mocks still in place.
afterEach(() => {
  cleanup();
  clearMocks();
});

function open(engines: EngineInfo[], onSetUpEngine = vi.fn()) {
  store.engines = engines;
  const created: unknown[] = [];
  mockIPC(
    (cmd, args) => {
      if (cmd === 'agents_create') {
        created.push((args as { input: unknown }).input);
        return { id: 'new' };
      }
      if (cmd === 'list_projects') return [];
      return null;
      // The policy section listens for changes; without mocked events its
      // unlisten throws on unmount (an unhandled error that failed the run).
    },
    { shouldMockEvents: true }
  );
  render(
    <ModalProvider>
      <AgentEditorModal isOpen onClose={vi.fn()} onSaved={vi.fn()} onSetUpEngine={onSetUpEngine} />
    </ModalProvider>
  );
  // New agent opens on describing; these tests are about the form under it.
  fireEvent.click(screen.getByRole('button', { name: 'fill it in yourself' }));
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
    expect(screen.queryByRole('button', { name: /^Runs on:/ })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: /^Runs on:/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/isn't set up/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Also use Codex' }));
    expect(onSetUpEngine).toHaveBeenCalledWith('codex', 'install');
    await create();
    await waitFor(() => expect(created[0]).toMatchObject({ engine: 'claude' }));
  });

  it('shows the picker once both are installed, with the reason one can’t be chosen', () => {
    open([CLAUDE, { ...CODEX, signedIn: false }]);
    fireEvent.click(screen.getByRole('button', { name: 'Runs on: Claude Code' }));
    expect(screen.getByRole('menuitem', { name: /Codex/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Claude Code/ })).not.toBeDisabled();
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

describe('AgentEditorModal: moving an agent that has a copy open', () => {
  const PROJECT = '/u/ShipStudio/acme-site';
  const agent = {
    id: 'site',
    name: 'Acme Site',
    color: 'blue',
    role: '',
    engine: 'claude',
    model: '',
    home: '/h/site',
    project: PROJECT,
    copy: {
      id: 'copy-1',
      project: PROJECT,
      path: '/u/ShipStudio/.worktrees/acme-site/acme-site-x-ab12',
      branch: 'acme-site/x-ab12',
      base: 'abc',
      baseBranch: 'main',
      createdAt: 1,
      deps: true,
    },
    permissions: [],
    status: { state: 'idle', activity: null, since: null },
  } as unknown as import('../../lib/agents').Agent;

  function edit(keep: unknown = { outcome: 'kept', files: 1, branch: 'main' }) {
    store.engines = [CLAUDE];
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC(
      (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'list_projects') return [{ name: 'acme-site', path: PROJECT }];
        if (cmd === 'agents_instructions') return '';
        if (cmd === 'agents_copy_keep') return keep;
        if (cmd === 'agents_update') return { id: 'site' };
        return null;
      },
      { shouldMockEvents: true }
    );
    render(
      <ModalProvider>
        <AgentEditorModal isOpen agent={agent} onClose={vi.fn()} onSaved={vi.fn()} />
      </ModalProvider>
    );
    return calls;
  }

  async function moveToNoProjectAndSave() {
    await act(() => Promise.resolve());
    // Project opens its page in place; back on the sheet, Done saves.
    fireEvent.click(screen.getByRole('button', { name: /^Project/ }));
    fireEvent.click(screen.getByRole('button', { name: /Works in:/ }));
    fireEvent.click(screen.getByText('No project'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit agent' }));
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      return Promise.resolve();
    });
  }

  it('asks Keep / Discard / Cancel first, and saves only once the copy is settled', async () => {
    const calls = edit();
    await moveToNoProjectAndSave();
    expect(
      screen.getByText(/Acme Site has a copy of acme-site open with changes that haven't been kept/)
    ).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === 'agents_update')).toBe(false);
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep changes' }));
      return Promise.resolve();
    });
    await waitFor(() => expect(calls.some((c) => c.cmd === 'agents_update')).toBe(true));
    const order = calls
      .map((c) => c.cmd)
      .filter((c) => c.startsWith('agents_copy') || c === 'agents_update');
    expect(order).toEqual(['agents_copy_keep', 'agents_update']);
  });

  it('stays put when the copy can’t be kept from here', async () => {
    const calls = edit({ outcome: 'conflict', files: ['a.css'] });
    await moveToNoProjectAndSave();
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep changes' }));
      return Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/can't be kept from here yet/)
    );
    expect(calls.some((c) => c.cmd === 'agents_update')).toBe(false);
  });

  it('Cancel leaves everything as it was', async () => {
    const calls = edit();
    await moveToNoProjectAndSave();
    // The rebind panel's own Cancel, not the sheet's.
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/has a copy of acme-site open/)).toBeNull();
    expect(calls.some((c) => c.cmd.startsWith('agents_copy') || c.cmd === 'agents_update')).toBe(
      false
    );
  });
});
