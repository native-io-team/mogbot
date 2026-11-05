import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentMessage, ConnectorCard } from '../../lib/agents';
import { ImportPlaybackCard } from './ImportPlaybackCard';

const answer = vi.fn((_a: string, _r: string, _text?: string) => Promise.resolve());
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  answerImportPlayback: (a: string, r: string, t?: string) => answer(a, r, t),
}));

const CARD: ConnectorCard = {
  kind: 'playback',
  talkId: 't',
  source: 'Grok',
  playback: [
    {
      key: 'p1',
      name: 'Finance',
      lines: [
        { kind: 'job', text: 'My job: tracks spending' },
        {
          kind: 'routine',
          text: 'Every Monday at 09:00: send last week’s spending (arrives paused: you switch it on)',
        },
        { kind: 'gap', text: 'I don’t have instructions yet: I only know my name and job' },
      ],
    },
  ],
};

const message = (status: 'pending' | 'allowed', choice?: string): AgentMessage =>
  ({
    id: 'm1',
    agentId: 'chief',
    kind: 'approval',
    text: '',
    at: 1,
    approval: {
      requestId: 'r1',
      title: 'Here’s what Finance will do for you',
      detail: '',
      status,
      choice,
      connector: CARD,
    },
  }) as unknown as AgentMessage;

describe('ImportPlaybackCard', () => {
  it('plays the plan back, gaps last, and asks what’s missing', () => {
    render(<ImportPlaybackCard message={message('pending')} card={CARD} />);
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByText(/Every Monday at 09:00/)).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[items.length - 1]).toMatch(/don’t have instructions/);
    expect(screen.getByText('Is there anything I’m missing?')).toBeInTheDocument();
    // Nothing typed: nothing to add.
    expect(screen.getByRole('button', { name: 'Add this' })).toBeDisabled();
  });

  it('sends what the user adds, or that it’s everything', async () => {
    answer.mockClear();
    render(<ImportPlaybackCard message={message('pending')} card={CARD} />);
    fireEvent.change(screen.getByTestId('agent-import-playback-input'), {
      target: { value: 'It also pays rent on the 1st' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add this' }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith('chief', 'r1', 'It also pays rent on the 1st')
    );
    fireEvent.click(screen.getByRole('button', { name: 'That’s everything' }));
    await waitFor(() => expect(answer).toHaveBeenLastCalledWith('chief', 'r1', undefined));
  });

  it('once answered, shows what was said and no buttons', () => {
    render(<ImportPlaybackCard message={message('allowed', 'You added: rent')} card={CARD} />);
    expect(screen.getByText('You added: rent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'That’s everything' })).toBeNull();
  });
});
