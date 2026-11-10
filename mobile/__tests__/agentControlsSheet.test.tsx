/**
 * Agent controls, rendered: only the controls the Mac serves, each through
 * its own path; the model and effort locked while a turn runs (the level
 * isn't); raising the level past the team's asks first; the team's usage
 * mode read-only, a tap from the usage sheet.
 */

import type { AgentIndependence } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));
const mockCall = jest.fn((method: string, ..._a: unknown[]) =>
  Promise.resolve(method === 'agents.usagePlan' ? { mode: 'save' } : {})
);
const mockSetEngine = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('../src/lib/session', () => ({
  call: (method: string, ...a: unknown[]) => mockCall(method, ...a),
  canCall: (m: string) => mockState.welcome.methods.includes(m),
  describeError: (e: unknown) => String(e),
  setAgentEngine: (...a: unknown[]) => mockSetEngine(...a),
}));
const mockChoose = jest.fn();
jest.mock('../src/components/menu', () => ({ choose: (...a: unknown[]) => mockChoose(...a) }));
jest.mock('../src/lib/haptics', () => ({
  haptic: { select: jest.fn(), error: jest.fn(), success: jest.fn(), light: jest.fn() },
}));

const ENGINES = [
  {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    signedIn: true,
    asks: true,
    models: [{ value: 'opus', label: 'Opus' }],
  },
  {
    id: 'codex',
    label: 'Codex',
    installed: true,
    signedIn: true,
    asks: true,
    models: [{ value: 'gpt-5-codex', label: 'GPT-5 Codex' }],
  },
];
const designer = {
  id: 'design',
  name: 'Designer',
  engine: 'claude',
  model: null as string | null,
  effort: 'high',
  context: { used: 1, window: 200_000, at: 1, model: 'claude-opus-5-5' },
  status: { state: 'idle' },
} as Record<string, unknown>;
const ALL = ['agents.update', 'agents.setAgentIndependence', 'agents.usagePlan'];
const mockState = {
  welcome: { methods: ALL, features: ['agents.engine', 'agents.effort'] },
  link: { kind: 'connected' },
  overview: {
    independence: 'judgement' as AgentIndependence,
    engines: ENGINES,
    agents: [designer],
  },
};
jest.mock('../src/lib/store', () => ({
  useApp: (select: (s: unknown) => unknown) => select(mockState),
  useServed: (m: string, f?: string) =>
    mockState.welcome.methods.includes(m) && (!f || mockState.welcome.features.includes(f)),
}));

import { AgentControls } from '../src/components/AgentControls';

const sheet = async () => {
  await render(<AgentControls agentId="design" />);
  // The usage mode's read settles.
  await act(async () => {});
};

describe('Agent controls', () => {
  beforeEach(() => {
    mockCall.mockClear();
    mockSetEngine.mockClear();
    mockPush.mockClear();
    mockChoose.mockClear();
    mockState.welcome = { methods: ALL, features: ['agents.engine', 'agents.effort'] };
    mockState.overview.agents = [{ ...designer }];
  });

  it('heads with what the next message runs on, and draws each control', async () => {
    await sheet();
    expect(screen.getByText('Agent controls')).toBeTruthy();
    expect(screen.getByText(/Designer · Opus 5\.5 · High/)).toBeTruthy();
    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('Switch to Codex…')).toBeTruthy();
    expect(screen.getByText('Effort')).toBeTruthy();
    expect(screen.getByText('Independence')).toBeTruthy();
    // One control: "Same as team" and the slider, never a list of the four levels.
    expect(screen.getByText('Same as team (Steady)')).toBeTruthy();
    expect(screen.getByTestId('independence-slider')).toBeTruthy();
    expect(screen.getByText(/^Save my limits, for the whole team/)).toBeTruthy();
    expect(screen.getByText('More about Designer')).toBeTruthy();
  });

  it('sets the effort through agents.update', async () => {
    await sheet();
    await act(async () => {
      fireEvent.press(screen.getByText('Medium'));
    });
    expect(mockSetEngine).toHaveBeenCalledWith('design', { effort: 'medium' });
    await act(async () => {
      fireEvent.press(screen.getByText('Opus'));
    });
    expect(mockSetEngine).toHaveBeenCalledWith('design', { model: 'opus' });
  });

  it('leaves out what the Mac doesn’t take', async () => {
    mockState.welcome = { methods: ['agents.update'], features: ['agents.engine'] };
    await sheet();
    expect(screen.queryByText('Effort')).toBeNull();
    expect(screen.queryByText('Independence')).toBeNull();
    expect(screen.getByText('Model')).toBeTruthy();
    // No usage plan served: the row is there, without a mode.
    expect(screen.queryByText(/Save my limits/)).toBeNull();
  });

  it('while a turn runs: model and effort locked, with why; the level open', async () => {
    mockState.overview.agents = [{ ...designer, status: { state: 'working' } }];
    await sheet();
    expect(screen.getByText(/when this turn ends/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Medium'));
    });
    expect(mockSetEngine).not.toHaveBeenCalled();
    await act(async () => {
      // The one control for it: the slider's stop, as everywhere.
      // The slider lays its stops out once it knows its width.
      fireEvent(screen.getByTestId('independence-slider'), 'layout', {
        nativeEvent: { layout: { width: 320, height: 44, x: 0, y: 0 } },
      });
    });
    await act(async () => {
      fireEvent.press(
        screen.getByTestId('independence-stop-often', { includeHiddenElements: true })
      );
    });
    expect(mockCall).toHaveBeenCalledWith('agents.setAgentIndependence', {
      agentId: 'design',
      level: 'often',
    });
  });

  it('raising it past the team’s level asks first', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await sheet();
    await act(async () => {
      // The slider lays its stops out once it knows its width.
      fireEvent(screen.getByTestId('independence-slider'), 'layout', {
        nativeEvent: { layout: { width: 320, height: 44, x: 0, y: 0 } },
      });
    });
    await act(async () => {
      fireEvent.press(
        screen.getByTestId('independence-stop-full_send', { includeHiddenElements: true })
      );
    });
    expect(alert).toHaveBeenCalledWith(
      'Let Designer do more than the team?',
      expect.stringMatching(/Sends, posts and pushes too/),
      expect.any(Array)
    );
    expect(mockCall).not.toHaveBeenCalledWith('agents.setAgentIndependence', expect.anything());
    // Its own button applies it.
    const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons[1].onPress?.());
    expect(mockCall).toHaveBeenCalledWith('agents.setAgentIndependence', {
      agentId: 'design',
      level: 'full_send',
    });
    alert.mockRestore();
  });

  it('usage and the agent sheet are a tap away', async () => {
    await sheet();
    fireEvent.press(screen.getByText('Usage'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/usage', params: { id: 'design' } });
    fireEvent.press(screen.getByText('More about Designer'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/agent/[id]', params: { id: 'design' } });
  });
});
