/**
 * A new agent's first open (`Starters`, `agents/starters.rs`): its three
 * tasks as buttons, one tap sends exactly those words, and they're gone once
 * the user has said anything.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import { showsStarters, type AgentStarter } from '@shipstudio/companion-protocol';
import { Starters } from '../src/components/Starters';

jest.mock('expo-haptics', () => ({}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));

const STARTERS: AgentStarter[] = [
  { text: 'Help me connect Gmail', connect: 'Gmail' },
  { text: 'Plan my week' },
  { text: 'What do you need from me to start?' },
];

describe('first-open starters', () => {
  it('shows each one, and a tap sends its words', async () => {
    const onSend = jest.fn();
    await render(<Starters starters={STARTERS} onSend={onSend} />);
    for (const s of STARTERS) expect(screen.getByText(s.text)).toBeTruthy();
    expect(screen.getAllByTestId('starter-connect')).toHaveLength(1);
    fireEvent.press(screen.getByText('Plan my week'));
    expect(onSend).toHaveBeenCalledWith('Plan my week');
  });

  it('shows only until the user says something', () => {
    const agent = { starters: STARTERS };
    expect(showsStarters(agent, [{ kind: 'agent' }, { kind: 'note' }])).toBe(true);
    expect(showsStarters(agent, [{ kind: 'agent' }, { kind: 'user' }])).toBe(false);
    expect(showsStarters({}, [{ kind: 'agent' }])).toBe(false);
    expect(showsStarters({ starters: [] }, [])).toBe(false);
  });
});
