import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentStarters } from './AgentStarters';
import { openingOf, showsStarters, type AgentDraft } from '../../lib/agents';

const STARTERS = [
  { text: 'Help me connect Gmail', connect: 'Gmail' },
  { text: 'Plan my week' },
  { text: 'What do you need from me to start?' },
];

describe('a new agent’s first-open starters', () => {
  it('shows each one, and a click sends exactly its words', () => {
    const onSend = vi.fn();
    render(<AgentStarters starters={STARTERS} onSend={onSend} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText('Help me connect Gmail').closest('button')?.dataset.connect).toBe(
      'Gmail'
    );
    fireEvent.click(screen.getByText('Plan my week'));
    expect(onSend).toHaveBeenCalledWith('Plan my week');
  });

  it('are shown only until the user says something', () => {
    expect(showsStarters({ starters: STARTERS }, [{ kind: 'agent' }])).toBe(true);
    expect(showsStarters({ starters: STARTERS }, [{ kind: 'agent' }, { kind: 'user' }])).toBe(
      false
    );
    expect(showsStarters({}, [])).toBe(false);
  });

  it('a draft passes on its welcome, first tasks and apps, and nothing it lacks', () => {
    const draft: AgentDraft = {
      name: 'Inbox',
      role: 'Mail',
      color: 'teal',
      instructions: '',
      routines: [],
      apps: ['Gmail'],
      welcome: 'I’m Inbox.',
      starters: [{ text: 'Sum up my mail', needs: ['Gmail'] }],
    };
    expect(openingOf(draft)).toEqual({
      welcome: 'I’m Inbox.',
      starters: [{ text: 'Sum up my mail', needs: ['Gmail'] }],
      apps: ['Gmail'],
    });
    expect(openingOf({ ...draft, welcome: undefined, starters: undefined, apps: [] })).toEqual({});
    expect(openingOf(null)).toEqual({});
  });
});
