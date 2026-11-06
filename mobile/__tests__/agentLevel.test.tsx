/**
 * One agent's own independence level, on the phone: the agent sheet's row
 * ("Same as team (Go hard)" first, then the four levels, written with
 * `agents.setAgentIndependence`), the list row's tiny label only when it
 * differs from the team's, and Settings saying how many are set on their own.
 */
import type { AgentIndependence } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

const mockCall = jest.fn((..._a: unknown[]) => Promise.resolve({}));
jest.mock('../src/lib/session', () => ({
  call: (...a: unknown[]) => mockCall(...a),
  describeError: (e: unknown) => String(e),
}));
const mockChoose = jest.fn();
jest.mock('../src/components/menu', () => ({
  choose: (...a: unknown[]) => mockChoose(...a),
}));
jest.mock('../src/lib/haptics', () => ({ haptic: { select: jest.fn(), error: jest.fn() } }));
const mockState = {
  welcome: { methods: ['agents.setAgentIndependence', 'agents.setIndependence'], features: [] },
  overview: {
    independence: 'go_hard' as AgentIndependence,
    agents: [
      { id: 'a1', name: 'Finance', independence: 'often' as AgentIndependence },
      { id: 'a2', name: 'Social Posts', independence: 'full_send' as AgentIndependence },
      { id: 'a3', name: 'Plain' },
    ],
  },
};
jest.mock('../src/lib/store', () => ({
  useApp: (select: (s: unknown) => unknown) => select(mockState),
  useServed: (m: string) => mockState.welcome.methods.includes(m),
}));

import {
  AgentLevelRow,
  IndependenceSetting,
  useAgentLevelLabel,
} from '../src/components/IndependenceSetting';

function Label({ agent }: { agent: { independence?: AgentIndependence } }) {
  return <Text>{useAgentLevelLabel(agent) ?? 'none'}</Text>;
}

describe('one agent’s level on the phone', () => {
  beforeEach(() => {
    mockCall.mockClear();
    mockChoose.mockClear();
    mockState.welcome.methods = ['agents.setAgentIndependence', 'agents.setIndependence'];
  });

  it('the sheet’s row follows the team by default, and offers the team first', async () => {
    await render(
      <AgentLevelRow agent={{ id: 'a3', name: 'Plain' }} enabled onError={() => {}} />
    );
    expect(screen.getByText('How much it does on its own')).toBeTruthy();
    expect(screen.getByText('Same as team (Go hard)')).toBeTruthy();
    fireEvent.press(screen.getByText('How much it does on its own'));
    const [title, choices] = mockChoose.mock.calls[0] as [string, { label: string; run: () => void }[]];
    expect(title).toBe('How much it does on its own');
    expect(choices.map((c) => c.label)).toEqual([
      'Same as team (Go hard)',
      'Check with me often',
      'Use good judgement',
      'Go hard — get it done',
      'Full send — let it rip',
    ]);
    choices[4].run();
    expect(mockCall).toHaveBeenCalledWith('agents.setAgentIndependence', {
      agentId: 'a3',
      level: 'full_send',
    });
    // Already the team's: nothing to write.
    mockCall.mockClear();
    choices[0].run();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('an agent with its own level shows it and can go back to the team', async () => {
    await render(
      <AgentLevelRow
        agent={{ id: 'a1', name: 'Finance', independence: 'often' }}
        enabled
        onError={() => {}}
      />
    );
    expect(screen.getByText('Check with me often')).toBeTruthy();
    fireEvent.press(screen.getByText('How much it does on its own'));
    const [, choices] = mockChoose.mock.calls[0] as [string, { run: () => void }[]];
    choices[0].run();
    expect(mockCall).toHaveBeenCalledWith('agents.setAgentIndependence', {
      agentId: 'a1',
      level: 'team',
    });
  });

  it('a Mac that doesn’t serve it shows no row', async () => {
    mockState.welcome.methods = ['agents.setIndependence'];
    await render(<AgentLevelRow agent={{ id: 'a3', name: 'Plain' }} enabled onError={() => {}} />);
    expect(screen.queryByText('How much it does on its own')).toBeNull();
  });

  it('the list row’s label shows only when it differs from the team', async () => {
    await render(<Label agent={{ independence: 'full_send' }} />);
    expect(screen.getByText('Full send')).toBeTruthy();
    await render(<Label agent={{ independence: 'often' }} />);
    expect(screen.getByText('Checks often')).toBeTruthy();
    await render(<Label agent={{ independence: 'go_hard' }} />);
    expect(screen.getByText('none')).toBeTruthy();
  });

  it('Settings says how many agents are set on their own', async () => {
    await render(<IndependenceSetting />);
    expect(screen.getByText(/Agents set on their own: 2\./)).toBeTruthy();
  });

  it('reads the Mac’s real overview: its agent on its own level', () => {
    expect(real.agentsOverview.agents[0].independence).toBe('full_send');
    expect(real.agentsSetAgentIndependence).toEqual({ agentId: 'a1', level: 'full_send' });
  });
});
