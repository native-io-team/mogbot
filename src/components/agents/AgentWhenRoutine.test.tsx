import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { WhenComposer } from './AgentWhenRoutine';
import type { Agent, CheckIn } from '../../lib/agents';

vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  refreshAgents: () => Promise.resolve(),
}));

afterEach(() => clearMocks());

const agent = { id: 'a1', name: 'Finance' } as Agent;

function mount(opts: { linear?: boolean; editing?: CheckIn | null; reject?: string } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === 'agents_apps_list') {
      return {
        connected: opts.linear
          ? [
              {
                name: 'linear',
                target: 'https://mcp.linear.app/mcp',
                status: 'connected',
                source: 'user',
              },
            ]
          : [],
        suggestions: [],
      };
    }
    if (cmd === 'agents_watch_create' || cmd === 'agents_watch_update') {
      // Tauri rejects with the CommandError value itself, not an Error.
      if (opts.reject) {
        const error = { type: 'Validation', field: 'folder', reason: opts.reject };
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject(error);
      }
      return { id: 'w1' };
    }
    return null;
  });
  const onDone = vi.fn();
  render(<WhenComposer agent={agent} editing={opts.editing ?? null} onDone={onDone} />);
  return { calls, onDone };
}

const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(name) });

describe('WhenComposer', () => {
  it('offers the free sources, says what each costs, and adds a GitHub one', async () => {
    const { calls, onDone } = mount();
    expect(radio('Someone mentions me on GitHub')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Someone mentions me on GitHub')).toHaveTextContent(
      'Free · checked with the GitHub CLI'
    );
    expect(screen.queryByRole('radio', { name: /Linear/ })).toBeNull();
    expect(screen.getByText(/Checks are free\./)).toBeInTheDocument();
    expect(screen.getByText(/nothing old starts work/)).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What to do when it happens'), {
      target: { value: 'Triage it' },
    });
    expect(
      screen.getByText('When someone mentions you on GitHub, Finance gets a turn.')
    ).toBeInTheDocument();
    await act(() => {
      fireEvent.click(add);
      return Promise.resolve();
    });
    const create = calls.find((c) => c.cmd === 'agents_watch_create');
    expect(create?.args).toEqual({
      agentId: 'a1',
      source: { kind: 'github_mentions' },
      everyMinutes: 10,
      note: 'Triage it',
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('offers Linear only when a Linear connector is there, and says a check costs a call', async () => {
    mount({ linear: true });
    await waitFor(() => expect(radio('A Linear issue is assigned to me')).toBeInTheDocument());
    fireEvent.click(radio('A Linear issue is assigned to me'));
    expect(
      screen.getByText(/a short Claude Code call on Haiku, counted in Finance’s usage/)
    ).toBeInTheDocument();
    // A model check can't be checked every 5 minutes: the choices start at 10.
    expect(screen.queryByRole('button', { name: 'every 5 min' })).toBeNull();
    expect(screen.getByRole('button', { name: 'every 4 hours' })).toBeInTheDocument();
  });

  it('asks for the folder, and shows the Mac’s reason when it refuses one', async () => {
    const { calls } = mount({ reject: 'There’s no folder at ~/Nope.' });
    fireEvent.click(radio('A new file appears in a folder'));
    expect(screen.getByText('Which folder?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What to do when it happens'), {
      target: { value: 'File it' },
    });
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Which folder'), { target: { value: '~/Nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'every minute' }));
    await act(() => {
      fireEvent.keyDown(screen.getByLabelText('Which folder'), { key: 'Enter' });
      return Promise.resolve();
    });
    expect(calls.find((c) => c.cmd === 'agents_watch_create')?.args).toMatchObject({
      source: { kind: 'new_file', folder: '~/Nope' },
      everyMinutes: 1,
    });
    expect(await screen.findByText('There’s no folder at ~/Nope.')).toBeInTheDocument();
  });

  it('edits in place, keeping what it had', async () => {
    const editing = {
      id: 'w9',
      note: 'Draft a reply',
      nextAt: 0,
      createdAt: 0,
      paused: false,
      watch: {
        source: { kind: 'custom', check: 'a new email from Dana' },
        everyMinutes: 30,
        lastFound: 0,
        failures: 0,
      },
    } as CheckIn;
    const { calls } = mount({ editing });
    expect(radio('Something else')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('What to look out for')).toHaveValue('a new email from Dana');
    expect(screen.getByRole('button', { name: 'every 30 min' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      return Promise.resolve();
    });
    expect(calls.find((c) => c.cmd === 'agents_watch_update')?.args).toEqual({
      agentId: 'a1',
      id: 'w9',
      source: { kind: 'custom', check: 'a new email from Dana' },
      everyMinutes: 30,
      note: 'Draft a reply',
    });
  });
});
