import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ComposerRevising, ResultCardView, RevisesBar } from './AgentResult';
import { AgentProjectsProvider, ChangeCard } from './AgentProject';
import {
  beforeAfter,
  changesLine,
  itemName,
  listedItems,
  newestResults,
  sendAgentMessage,
  type Agent,
  type AgentMessage,
  type ResultCard,
} from '../../lib/agents';

const agent = {
  id: 'fin',
  name: 'Finance',
  home: '/h/fin',
  status: { state: 'idle', activity: null, since: null },
} as Agent;

const PDF = {
  name: 'oct.pdf',
  path: 'attachments/r1/oct.pdf',
  mime: 'application/pdf',
  size: 2048,
};
const BEFORE = { name: 'b.png', path: 'attachments/r1/b.png', mime: 'image/png', size: 9 };
const AFTER = { name: 'a.png', path: 'attachments/r1/a.png', mime: 'image/png', size: 9 };

const V1: ResultCard = {
  id: 'res-1',
  version: 1,
  title: 'October summary',
  summary: 'Every invoice on one page.',
  items: [
    { kind: 'file', file: PDF, label: 'Summary' },
    { kind: 'link', url: 'https://docs.example.com/sheet', label: 'Source sheet' },
  ],
  checked: ['Totals match the bank'],
  notVerified: ['EUR rate is today’s'],
};

const message = (card: ResultCard, id = 'r1'): AgentMessage => ({
  id,
  agentId: 'fin',
  ts: 1,
  kind: 'agent',
  text: card.summary,
  attachments: [PDF],
  result: card,
});

afterEach(() => clearMocks());

describe('the result card', () => {
  it('shows what the agent gave, with Not verified up front', () => {
    const ask = vi.fn();
    render(
      <ResultCardView message={message(V1)} card={V1} agent={agent} newest onAskForChanges={ask} />
    );
    const card = screen.getByRole('article', { name: 'Result: October summary' });
    expect(within(card).getByText('Every invoice on one page.')).toBeTruthy();
    const unverified = within(card).getByRole('region', { name: 'Not verified' });
    expect(unverified.textContent).toContain('EUR rate is today’s');
    // Before the files: it's what the eye should land on.
    const order = [...card.querySelectorAll('.agent-result__unverified, .agent-result__items')];
    expect(order[0].className).toContain('unverified');
    expect(within(card).getByRole('region', { name: 'Checked' }).textContent).toContain(
      'Totals match the bank'
    );
    expect(screen.queryByText(/v1/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ask for changes/ }));
    expect(ask).toHaveBeenCalledWith({ id: 'res-1', version: 1, title: 'October summary' });
  });

  it('never invents a list the agent didn’t give', () => {
    const bare: ResultCard = { id: 'r', version: 1, title: 'Brief', summary: 'S' };
    render(<ResultCardView message={message(bare)} card={bare} agent={agent} newest />);
    expect(screen.queryByRole('region', { name: 'Not verified' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Checked' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'What it made' })).toBeNull();
    // No handler, no Ask for changes.
    expect(screen.queryByRole('button', { name: /Ask for changes/ })).toBeNull();
  });

  it('opens files in their app and links in the browser', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return null;
    });
    render(<ResultCardView message={message(V1)} card={V1} agent={agent} newest />);
    fireEvent.click(screen.getByTitle('Open oct.pdf'));
    fireEvent.click(screen.getByTitle('Open https://docs.example.com/sheet'));
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toEqual([
      'agents_open_attachment',
      { agentId: 'fin', path: 'attachments/r1/oct.pdf', reveal: false },
    ]);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://docs.example.com/sheet'));
  });

  it('shows a before and after side by side', () => {
    const card: ResultCard = {
      ...V1,
      items: [
        { kind: 'file', file: BEFORE, role: 'before' },
        { kind: 'file', file: AFTER, role: 'after' },
      ],
    };
    render(<ResultCardView message={message(card)} card={card} agent={agent} newest />);
    const pair = screen.getByLabelText('Before and after');
    expect(within(pair).getByText('Before')).toBeTruthy();
    expect(within(pair).getByText('After')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'What it made' })).toBeNull();
  });

  it('folds an older version to a line, and opens it on request', () => {
    const v2: ResultCard = { ...V1, version: 2, changes: 'Used the invoice-date rate' };
    const { rerender } = render(
      <ResultCardView message={message(V1)} card={V1} agent={agent} newest={false} />
    );
    expect(screen.getByText('October summary · v1 · a newer version is below')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /a newer version/ }));
    expect(screen.getByRole('article')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ask for changes/ })).toBeNull();
    rerender(
      <ResultCardView
        message={message(v2, 'r2')}
        card={v2}
        agent={agent}
        newest
        onAskForChanges={vi.fn()}
      />
    );
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('Changes since v1: Used the invoice-date rate')).toBeTruthy();
  });
});

describe('a project copy’s card carrying the result', () => {
  it('is one card, with Keep and Ask for changes together', () => {
    const copy = { id: 'copy-1', path: '/w/copy', branch: 'fin/x' };
    const owner = {
      ...agent,
      project: '/p/site',
      copy: { ...copy, project: '/p/site', base: 'b', createdAt: 1, deps: false },
    } as Agent;
    const changes: AgentMessage = {
      ...message(V1),
      kind: 'changes',
      changes: {
        project: '/p/site',
        from: 'a',
        to: 'b',
        files: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0 }],
        fileCount: 1,
        added: 1,
        removed: 0,
        copy,
      },
    };
    const ask = vi.fn();
    render(
      <AgentProjectsProvider onOpenProject={vi.fn()}>
        <ChangeCard
          message={changes}
          agent={owner}
          live
          owner={owner}
          newestResult
          onAskForChanges={ask}
        />
      </AgentProjectsProvider>
    );
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Keep changes' })).toBeTruthy();
    const asks = screen.getAllByRole('button', { name: /Ask for changes/ });
    expect(asks).toHaveLength(1);
    fireEvent.click(asks[0]);
    expect(ask).toHaveBeenCalledWith({ id: 'res-1', version: 1, title: 'October summary' });
  });
});

describe('asking for changes', () => {
  it('waits above the composer and can be dropped', () => {
    const drop = vi.fn();
    render(
      <ComposerRevising
        revising={{ id: 'res-1', version: 1, title: 'October summary' }}
        onRemove={drop}
      />
    );
    expect(screen.getByText('Changes to October summary · v1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Don't ask for changes" }));
    expect(drop).toHaveBeenCalled();
  });

  it('marks the message it sent', () => {
    render(<RevisesBar revises={{ id: 'res-1', version: 2, title: 'October summary' }} />);
    expect(screen.getByText('Changes to October summary · v2')).toBeTruthy();
  });

  it('sends the result id with the message', async () => {
    let sent: unknown;
    mockIPC((cmd, args) => {
      if (cmd === 'agents_send') sent = args;
      return {};
    });
    await sendAgentMessage('fin', 'Use the invoice date', [], [], 'res-1');
    expect(sent).toMatchObject({ agentId: 'fin', text: 'Use the invoice date', revises: 'res-1' });
  });
});

describe('result rules shared with the phone', () => {
  it('finds each result’s newest version', () => {
    const v2 = { ...V1, version: 2 };
    const other = { ...V1, id: 'res-2' };
    const newest = newestResults([
      { id: 'a', result: V1 },
      { id: 'b' },
      { id: 'c', result: v2 },
      { id: 'd', result: other },
    ]);
    expect([...newest.values()]).toEqual(['c', 'd']);
  });

  it('says what changed only when the agent did', () => {
    expect(changesLine(V1)).toBeNull();
    expect(changesLine({ ...V1, version: 2 })).toBeNull();
    expect(changesLine({ ...V1, version: 3, changes: ' New rate ' })).toBe(
      'Changes since v2: New rate'
    );
  });

  it('names items and pairs pictures', () => {
    expect(itemName({ kind: 'link', url: 'https://acme.com/' })).toBe('acme.com');
    expect(itemName({ kind: 'link', url: 'https://acme.com/a/b' })).toBe('acme.com/a/b');
    expect(itemName({ kind: 'file', file: PDF })).toBe('oct.pdf');
    const items = [
      { kind: 'file' as const, file: BEFORE, role: 'before' as const },
      { kind: 'file' as const, file: PDF },
    ];
    // One side alone isn't a comparison: it's listed.
    expect(beforeAfter(items)).toBeNull();
    expect(listedItems(items)).toHaveLength(2);
    const both = [...items, { kind: 'file' as const, file: AFTER, role: 'after' as const }];
    expect(beforeAfter(both)?.after).toBe(AFTER);
    expect(listedItems(both)).toEqual([{ kind: 'file', file: PDF }]);
  });
});
