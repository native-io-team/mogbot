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

type AppRow = { name: string; target: string; status: string; source: string };

/** One of our own connections (`agents_connections`), fictional. */
function ours(service: string, serverKey: string, title: string, agentIds: string[]) {
  return {
    id: `c-${serverKey}`,
    service,
    title,
    account: 'sam@example.com',
    kind: { type: 'oauth', serverUrl: 'https://mcp.example.com/mcp' },
    serverKey,
    createdAt: 0,
    grants: agentIds.map((agentId) => ({ agentId, access: 'read', grantedAt: 0 })),
  };
}

function mount(
  opts: {
    linear?: boolean;
    apps?: AppRow[];
    connections?: ReturnType<typeof ours>[];
    editing?: CheckIn | null;
    reject?: string;
  } = {}
) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === 'agents_connections') return opts.connections ?? [];
    if (cmd === 'agents_apps_list') {
      return {
        connected: [
          ...(opts.linear
            ? [
                {
                  name: 'linear',
                  target: 'https://mcp.linear.app/mcp',
                  status: 'connected',
                  source: 'user',
                },
              ]
            : []),
          ...(opts.apps ?? []),
        ],
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
    // The choice and the readback speak in one person.
    expect(radio('Someone mentions you on GitHub')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Someone mentions you on GitHub')).toHaveTextContent(
      'Free · checked from this Mac'
    );
    expect(screen.queryByRole('radio', { name: /Linear/ })).toBeNull();
    expect(screen.getByText(/Checks are free\./)).toBeInTheDocument();
    expect(screen.getByText(/nothing old starts work/)).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText('What to do when it happens'), {
      target: { value: 'Triage it' },
    });
    // Read back as the time picker's echo: what it waits for — what it does.
    expect(screen.getByText('When someone mentions you on GitHub — Triage it')).toBeInTheDocument();
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

  it('offers Linear only when a Linear app is there, and says a check costs a call', async () => {
    mount({ linear: true });
    await waitFor(() => expect(radio('A Linear issue is assigned to you')).toBeInTheDocument());
    fireEvent.click(radio('A Linear issue is assigned to you'));
    expect(
      screen.getByText(
        /uses a little of Finance’s usage and can only read that app, up to 24 a day/
      )
    ).toBeInTheDocument();
    // A model check is at least 15 minutes apart, and starts at 30.
    expect(screen.queryByRole('button', { name: 'every 10 min' })).toBeNull();
    expect(screen.getByRole('button', { name: 'every 15 min' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'every 30 min' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'every 4 hours' }));
    expect(screen.getByText(/up to 6 a day/)).toBeInTheDocument();
  });

  it('offers Linear connected under Apps for this agent, with no Claude Code server', async () => {
    mount({ connections: [ours('linear', 'linear', 'Linear', ['a1'])] });
    await waitFor(() => expect(radio('A Linear issue is assigned to you')).toBeInTheDocument());
  });

  it('doesn’t offer Linear connected only for another agent', async () => {
    const { calls } = mount({ connections: [ours('linear', 'linear', 'Linear', ['other'])] });
    await waitFor(() => expect(calls.some((c) => c.cmd === 'agents_apps_list')).toBe(true));
    await act(() => Promise.resolve());
    expect(screen.queryByRole('radio', { name: /Linear/ })).toBeNull();
  });

  it('checks “something else” through our own app first, saved by its key', async () => {
    const { calls } = mount({
      connections: [ours('notion', 'notion', 'Notion', ['a1'])],
      apps: [
        { name: 'figma', target: 'https://mcp.figma.com/mcp', status: 'connected', source: 'user' },
      ],
    });
    fireEvent.click(radio('Something else'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notion' })).toBeInTheDocument());
    const order = screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t === 'Notion' || t === 'Figma');
    expect(order).toEqual(['Notion', 'Figma']);
    fireEvent.click(screen.getByRole('button', { name: 'Notion' }));
    fireEvent.change(screen.getByLabelText('What to look out for'), {
      target: { value: 'a new page in the roadmap' },
    });
    fireEvent.change(screen.getByLabelText('What to do when it happens'), {
      target: { value: 'Summarise it' },
    });
    // The user's own words are quoted, so the echo reads whatever they typed.
    expect(
      screen.getByText('When Finance finds “a new page in the roadmap” — Summarise it')
    ).toBeInTheDocument();
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      return Promise.resolve();
    });
    const create = calls.find((c) => c.cmd === 'agents_watch_create');
    expect(create?.args.source).toEqual({
      kind: 'custom',
      check: 'a new page in the roadmap',
      app: 'notion',
    });
  });

  it('never offers a claude.ai connector: the sealed check can’t load one', async () => {
    const { calls } = mount({
      apps: [
        { name: 'claude.ai Linear', target: 'x', status: 'connected', source: 'claudeAi' },
        { name: 'claude.ai Gmail', target: 'x', status: 'connected', source: 'claudeAi' },
      ],
    });
    await waitFor(() => expect(calls.some((c) => c.cmd === 'agents_apps_list')).toBe(true));
    expect(screen.queryByRole('radio', { name: /Linear/ })).toBeNull();
    fireEvent.click(radio('Something else'));
    expect(
      screen.getByText(/Apps connected on claude\.ai\s+can’t be used here/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /claude\.ai/ })).toBeNull();
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
        source: { kind: 'custom', check: 'a new email from Dana', app: 'gmail' },
        everyMinutes: 30,
        lastFound: 0,
        failures: 0,
      },
    } as CheckIn;
    const { calls } = mount({
      editing,
      apps: [
        { name: 'gmail', target: 'npx gmail-mcp', status: 'connected', source: 'user' },
        {
          name: 'notion',
          target: 'https://mcp.notion.com/mcp',
          status: 'connected',
          source: 'user',
        },
      ],
    });
    expect(await screen.findByRole('button', { name: 'Gmail' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
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
      source: { kind: 'custom', check: 'a new email from Dana', app: 'gmail' },
      everyMinutes: 30,
      note: 'Draft a reply',
    });
  });

  it('asks which app before an app check can be added', async () => {
    mount({
      apps: [{ name: 'gmail', target: 'npx gmail-mcp', status: 'connected', source: 'user' }],
    });
    fireEvent.click(radio('Something else'));
    fireEvent.change(screen.getByLabelText('What to look out for'), {
      target: { value: 'a new email from Dana' },
    });
    fireEvent.change(screen.getByLabelText('What to do when it happens'), {
      target: { value: 'Draft a reply' },
    });
    expect(await screen.findByText('Which app should it check?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    // The apps list loads on its own: wait for its button, not just the question.
    fireEvent.click(await screen.findByRole('button', { name: 'Gmail' }));
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });
});
