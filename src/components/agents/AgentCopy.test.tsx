import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentProjectField, AgentProjectsProvider, ChangeCard } from './AgentProject';
import { copyLine, resolvePrompt } from './AgentCopy';
import { resetReviewHandoff, takeSubmitReview } from '../../lib/reviewHandoff';
import type { Agent, AgentMessage, AgentStatus, KeptCopy } from '../../lib/agents';

const PROJECT = '/u/ShipStudio/acme-site';
const COPY = {
  id: 'copy-1',
  path: '/u/ShipStudio/.worktrees/acme-site/acme-site-blue-header-ab12',
  branch: 'acme-site/blue-header-ab12',
};

const agent = (state: AgentStatus['state'] = 'idle'): Agent =>
  ({
    id: 'site',
    name: 'Acme Site',
    home: '/h/site',
    project: PROJECT,
    copy: { ...COPY, project: PROJECT, base: 'abc', createdAt: 1, deps: true },
    status: { state, activity: null, since: null },
  }) as Agent;

const card: AgentMessage = {
  id: 'm1',
  agentId: 'site',
  ts: 1,
  kind: 'changes',
  text: 'Changed 2 files in a copy of acme-site',
  changes: {
    project: PROJECT,
    from: 'base',
    to: 'now',
    files: [
      { path: 'index.html', status: 'modified', added: 1, removed: 1 },
      { path: 'blue.css', status: 'added', added: 3 },
    ],
    fileCount: 2,
    added: 4,
    removed: 1,
    copy: COPY,
  },
};

function show(props: { agent?: Agent; live?: boolean }, onOpenProject = vi.fn()) {
  render(
    <AgentProjectsProvider onOpenProject={onOpenProject}>
      <ChangeCard message={card} {...props} />
    </AgentProjectsProvider>
  );
  return onOpenProject;
}

function backend(keep: KeptCopy | Error = { outcome: 'kept', files: 2 }) {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'list_projects') return [{ name: 'acme-site', path: PROJECT }];
    if (cmd === 'agents_copy_keep') {
      if (keep instanceof Error) throw keep;
      return keep;
    }
    if (cmd === 'agents_copy_discard') return null;
    if (cmd === 'agents_send') return { id: 'u1' };
    return null;
  });
  return calls;
}

afterEach(() => {
  clearMocks();
  resetReviewHandoff();
});

describe('a change card for a copy of the project', () => {
  it('says the changes are ready, in plain words, with Keep · Review · Preview · Discard', async () => {
    backend();
    show({ agent: agent(), live: true });
    await act(() => Promise.resolve());
    expect(screen.getByText('Changes are ready')).toBeInTheDocument();
    expect(
      screen.getByText('On a copy of acme-site · acme-site itself is unchanged')
    ).toBeInTheDocument();
    for (const name of ['Keep changes', 'Review', 'Preview', 'Discard']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    // No git words on the card.
    expect(screen.queryByText(/branch|merge|worktree/i)).toBeNull();
  });

  it('keeps the changes of the copy it describes', async () => {
    const calls = backend();
    show({ agent: agent(), live: true });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole('button', { name: 'Keep changes' }));
    });
    expect(calls.find((c) => c.cmd === 'agents_copy_keep')?.args).toEqual({
      agentId: 'site',
      copyId: 'copy-1',
    });
  });

  it('waits while the agent is still working in the copy', async () => {
    backend();
    show({ agent: agent('working'), live: true });
    await act(() => Promise.resolve());
    expect(screen.getByText('Acme Site is working on a copy of acme-site')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('asks before discarding, then discards that copy', async () => {
    const calls = backend();
    show({ agent: agent(), live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByText(/Discard these changes\?/)).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === 'agents_copy_discard')).toBe(false);
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    });
    expect(calls.find((c) => c.cmd === 'agents_copy_discard')?.args).toEqual({
      agentId: 'site',
      copyId: 'copy-1',
    });
  });

  it('turns an overlap into a choice: open the copy, or ask the agent', async () => {
    const calls = backend({ outcome: 'conflict', files: ['index.html'] });
    const open = show({ agent: agent(), live: true });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole('button', { name: 'Keep changes' }));
    });
    expect(screen.getByText(/overlap with edits made in acme-site since/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the copy' }));
    expect(open).toHaveBeenCalledWith(COPY.path);
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole('button', { name: 'Ask Acme Site' }));
    });
    const sent = calls.find((c) => c.cmd === 'agents_send')?.args as { text: string };
    expect(sent.text).toBe(resolvePrompt('acme-site', ['index.html']));
  });

  it('previews and opens a pull request in the copy', () => {
    backend();
    const open = show({ agent: agent(), live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(open).toHaveBeenLastCalledWith(COPY.path);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByText('Open a pull request'));
    expect(open).toHaveBeenLastCalledWith(COPY.path);
    // The workspace opens the pull request flow once it shows that copy.
    expect(takeSubmitReview(PROJECT, 'main')).toBeNull();
    expect(takeSubmitReview(COPY.path, COPY.branch)).toBe(COPY.branch);
    expect(takeSubmitReview(COPY.path, COPY.branch)).toBeNull();
  });

  it('an earlier card of the copy is a record, without actions', async () => {
    backend();
    show({});
    await act(() => Promise.resolve());
    expect(screen.getByText('Changed 2 files in a copy of acme-site')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep changes' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View diff' })).toBeInTheDocument();
  });

  it('offers working directly only once a project is picked', async () => {
    backend();
    const onDirect = vi.fn();
    const { rerender } = render(
      <AgentProjectField value="" onChange={() => {}} onDirectChange={onDirect} />
    );
    expect(screen.queryByLabelText('Work directly in the project')).toBeNull();
    rerender(<AgentProjectField value={PROJECT} onChange={() => {}} onDirectChange={onDirect} />);
    await act(() => Promise.resolve());
    expect(screen.getByText(/works on its own copy of this project/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Work directly in the project'));
    expect(onDirect).toHaveBeenCalledWith(true);
  });

  it('words the sub-line by state', () => {
    expect(copyLine('Acme Site', 'acme-site', true)).toBe(
      'Acme Site is working on a copy of acme-site'
    );
  });
});
