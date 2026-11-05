import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentMessage, ConnectorCard, ImportPicks } from '../../lib/agents';
import { ImportReviewCard, lineDiff } from './ImportReviewCard';

const apply = vi.fn((_a: string, _r: string, _p: ImportPicks) =>
  Promise.resolve({ agents: [], replaced: [], skipped: [], chiefNotes: false, routinesRefused: [] })
);
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  applyImportReview: (a: string, r: string, p: ImportPicks) => apply(a, r, p),
}));

const CARD: ConnectorCard = {
  kind: 'review',
  talkId: 't',
  source: 'Grok',
  review: {
    proposals: [
      {
        key: 'p1',
        name: 'Finance',
        role: 'Money',
        instructions: 'Log every expense.\nAsk before paying.',
        memory: '- Accountant is Lena',
        routines: [
          {
            when: 'every weekday at 9am',
            what: 'Check invoices',
            schedule: 'every weekday at 09:00',
          },
        ],
        logins: [{ name: 'bank_login', purpose: 'Reads statements', kind: 'password' }],
        clash: { agentId: 'f', role: 'Mine', instructions: 'My own rules.\nAsk before paying.' },
      },
      {
        key: 'p2',
        name: 'Travel',
        role: 'Trips',
        instructions: 'Book trains.',
        memory: '',
        routines: [],
        logins: [],
      },
    ],
    chiefNotes: '- Prefers mornings',
  },
};

function message(status: 'pending' | 'allowed' | 'denied' | 'expired' = 'pending'): AgentMessage {
  return {
    id: 'm1',
    agentId: 'chief',
    ts: 0,
    kind: 'approval',
    text: '',
    approval: {
      requestId: 'r1',
      title: 'Bring in 2 agents from Grok',
      detail: '',
      status,
      choice: status === 'allowed' ? 'Imported Finance (from Grok), Travel' : undefined,
      connector: CARD,
    },
  } as AgentMessage;
}

describe('ImportReviewCard', () => {
  it('imports what is ticked, as copies by default, and leaves the Chief alone unless asked', async () => {
    apply.mockClear();
    render(<ImportReviewCard message={message()} card={CARD} chiefName="Ada" onAnswer={vi.fn()} />);
    expect(screen.getByText(/Nothing is created until you import/)).toBeInTheDocument();
    // A taken name comes in as a copy unless Replace is chosen.
    expect(screen.getByText('Finance (from Grok)')).toBeInTheDocument();
    expect(screen.getByText('Name taken here')).toBeInTheDocument();
    // The Chief's notes are off by default.
    expect(screen.getByRole('checkbox', { name: 'Add to Ada’s notes' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Travel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 agent' }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith('chief', 'r1', {
        agents: [{ key: 'p1', replace: false }],
        chiefNotes: false,
      })
    );
  });

  it('replaces only when chosen, with the diff and what it costs shown first', async () => {
    apply.mockClear();
    render(<ImportReviewCard message={message()} card={CARD} chiefName="Ada" onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByText('Finance (from Grok)'));
    expect(
      screen.getByText('Logins it asks for · on secure cards, never here')
    ).toBeInTheDocument();
    expect(screen.getByText('every weekday at 09:00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace your Finance' }));
    expect(screen.getByText(/its “Always allow” rules are removed/)).toBeInTheDocument();
    const diff = screen.getByLabelText('What changes');
    expect(diff.textContent).toContain('− My own rules.');
    expect(diff.textContent).toContain('+ Log every expense.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add to Ada’s notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 agents' }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith('chief', 'r1', {
        agents: [
          { key: 'p1', replace: true },
          { key: 'p2', replace: false },
        ],
        chiefNotes: true,
      })
    );
  });

  it('Don’t import answers the card no; an answered card just says what happened', () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    const { unmount } = render(
      <ImportReviewCard message={message()} card={CARD} chiefName="Ada" onAnswer={onAnswer} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Don’t import' }));
    expect(onAnswer).toHaveBeenCalledWith('r1', false);
    unmount();
    render(
      <ImportReviewCard
        message={message('allowed')}
        card={CARD}
        chiefName="Ada"
        onAnswer={vi.fn()}
      />
    );
    expect(screen.getByText('Imported Finance (from Grok), Travel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import/ })).not.toBeInTheDocument();
  });
});

describe('lineDiff', () => {
  it('keeps shared lines and marks the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });
});
