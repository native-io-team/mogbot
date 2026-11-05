import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentProjectField, AgentProjectsProvider, ChangeCard } from './AgentProject';
import { copyLine, keepHint, keptToast, otherBranchNote, resolvePrompt } from './AgentCopy';
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

function backend(
  keep: KeptCopy | Error | ((args: unknown) => KeptCopy) = {
    outcome: 'kept',
    files: 2,
    branch: 'main',
  }
) {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'list_projects') return [{ name: 'acme-site', path: PROJECT }];
    if (cmd === 'agents_copy_keep') {
      if (keep instanceof Error) throw keep;
      return typeof keep === 'function' ? keep(args) : keep;
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

  it('asks before keeping into a branch the copy wasn’t made from, naming both', async () => {
    const calls = backend((args) =>
      (args as { into?: string }).into === 'feature'
        ? { outcome: 'kept', files: 2, branch: 'feature' }
        : { outcome: 'otherBranch', current: 'feature', base: 'main' }
    );
    show({ agent: agent(), live: true });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole('button', { name: 'Keep changes' }));
    });
    expect(screen.getByText(otherBranchNote('acme-site', 'feature', 'main'))).toBeInTheDocument();
    expect(otherBranchNote('acme-site', 'feature', 'main')).toMatch(/on feature now.*from main/);
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole('button', { name: 'Keep into feature' }));
    });
    const keeps = calls.filter((c) => c.cmd === 'agents_copy_keep').map((c) => c.args);
    expect(keeps).toEqual([
      { agentId: 'site', copyId: 'copy-1' },
      { agentId: 'site', copyId: 'copy-1', into: 'feature' },
    ]);
  });

  it('refuses while a file still has conflict markers, and says which', async () => {
    backend({ outcome: 'markers', files: ['style.css'] });
    show({ agent: agent(), live: true });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole('button', { name: 'Keep changes' }));
    });
    expect(screen.getByText(/still have conflict markers in them/)).toBeInTheDocument();
    expect(screen.getByText('style.css')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask Acme Site' })).toBeEnabled();
  });

  it('lists what Keep won’t bring over, and why the copy couldn’t save', async () => {
    backend();
    render(
      <AgentProjectsProvider onOpenProject={vi.fn()}>
        <ChangeCard
          message={{
            ...card,
            changes: {
              ...card.changes!,
              leftOut: [
                { path: '.env.local', why: 'secrets' },
                { path: '.env', why: 'ignored' },
              ],
              warning: 'The copy isn’t on its own branch any more — open it to check.',
            },
          }}
          agent={agent()}
          live
        />
      </AgentProjectsProvider>
    );
    await act(() => Promise.resolve());
    expect(
      screen.getByText(
        'Not included: .env.local (looks like secrets) · changed .env — not included (git ignores it)'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('isn’t on its own branch any more');
  });

  it('shows what stopped the last Keep from the agent’s copy, without pressing Keep again', async () => {
    backend();
    const stuckAgent = agent();
    stuckAgent.copy = { ...stuckAgent.copy!, stuck: { outcome: 'markers', files: ['style.css'] } };
    show({ agent: stuckAgent, live: true });
    await act(() => Promise.resolve());
    expect(screen.getByText(/still have conflict markers in them/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByRole('button', { name: 'Keep changes' })).toBeInTheDocument();
  });

  it('says where Keep puts the changes', () => {
    expect(keepHint('Acme Site', 'acme-site', 'main')).toBe(
      "Brings these changes into acme-site: adds Acme Site's commits to main"
    );
    expect(keptToast('acme-site', { outcome: 'kept', files: 2, branch: 'main' })).toBe(
      'Kept the changes in acme-site (main)'
    );
    expect(
      keptToast('acme-site', {
        outcome: 'nothing',
        leftOut: [{ path: '.env', why: 'ignored' }],
      })
    ).toBe('acme-site already has these changes · changed .env — not included (git ignores it)');
    expect(resolvePrompt('acme-site', ['a.css'])).not.toMatch(/commit the result/);
  });

  it('words the sub-line by state', () => {
    expect(copyLine('Acme Site', 'acme-site', true)).toBe(
      'Acme Site is working on a copy of acme-site'
    );
  });
});
