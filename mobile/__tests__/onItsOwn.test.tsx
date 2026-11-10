/**
 * "What can it do on its own?" on the phone: the Mac's real view (generated
 * fixtures) drawn in the shared sections, each narrow one tap that sends
 * exactly that narrow, a refusal kept on screen, and the team's view taking
 * a shared rule back through the Chief.
 */
import type { OnItsOwn, OnItsOwnTeam } from '@shipstudio/companion-protocol';
import { onItsOwnSections, timeLeftLine } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// Reanimated's own mock needs its native module; these only need views and presets.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  preset.duration = () => preset;
  preset.delay = () => preset;
  return {
    __esModule: true,
    default: { View },
    FadeIn: preset,
    FadeOut: preset,
    LinearTransition: preset,
  };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
const mockCall = jest.fn();
jest.mock('../src/lib/session', () => ({
  call: (...a: unknown[]) => mockCall(...a),
  describeError: (e: { message?: string }) => e?.message ?? 'Something went wrong',
}));
jest.mock('../src/lib/haptics', () => ({ haptic: { success: jest.fn(), error: jest.fn() } }));
const mockState = {
  link: { kind: 'connected' },
  welcome: {
    methods: ['agents.onItsOwn', 'agents.onItsOwnTeam', 'agents.onItsOwnNarrow'],
    features: [],
  },
  overview: {
    agents: [
      { id: 'chief', name: 'Chief of Staff', isMain: true },
      { id: 'a1', name: 'Finance', isMain: false },
    ],
  },
};
jest.mock('../src/lib/store', () => ({
  useApp: (select: (s: unknown) => unknown) => select(mockState),
  useServed: (m: string) => mockState.welcome.methods.includes(m),
}));

import { OnItsOwnList, OnItsOwnTeamList, itemDetail } from '../src/components/onItsOwn';

const view = real.agentsOnItsOwn as OnItsOwn;
const team = real.agentsOnItsOwnTeam as OnItsOwnTeam;

beforeEach(() => {
  mockPush.mockReset();
  mockCall.mockReset().mockImplementation((method: string, params: { narrow?: unknown }) => {
    if (method === 'agents.onItsOwn') return Promise.resolve(view);
    if (method === 'agents.onItsOwnTeam') return Promise.resolve(team);
    if (method === 'agents.onItsOwnNarrow') {
      const taken = JSON.stringify(params.narrow);
      return Promise.resolve({
        ...view,
        items: view.items.filter((i) => !i.narrow.some((n) => JSON.stringify(n) === taken)),
      });
    }
    return Promise.reject(new Error(method));
  });
});

describe('one agent', () => {
  it('shows its level, what always asks, and every item in the Mac’s words', async () => {
    await render(<OnItsOwnList agentId="a1" />);
    await screen.findByText('Unleashed · its own level');
    expect(screen.getByText(view.levelLine)).toBeTruthy();
    for (const line of view.alwaysAsks) expect(screen.getByText(line)).toBeTruthy();
    for (const item of view.items) expect(screen.getByText(item.text)).toBeTruthy();
    for (const s of onItsOwnSections(view.items)) expect(screen.getByText(s.title)).toBeTruthy();
  });

  it('takes one thing away in a tap, sending exactly the narrow offered', async () => {
    await render(<OnItsOwnList agentId="a1" />);
    await screen.findByText('Uses Gmail (work@acme.com)');
    fireEvent.press(screen.getByLabelText('Read only'));
    await waitFor(() =>
      expect(mockCall).toHaveBeenCalledWith('agents.onItsOwnNarrow', {
        agentId: 'a1',
        narrow: { kind: 'app_read_only', connectionId: 'c1' },
      })
    );
    await waitFor(() => expect(screen.queryByText('Uses Gmail (work@acme.com)')).toBeNull());
  });

  it('keeps the list and says why when the Mac refuses', async () => {
    mockCall.mockImplementationOnce(() => Promise.resolve(view));
    mockCall.mockImplementationOnce(() => Promise.reject({ message: 'That’s already gone.' }));
    await render(<OnItsOwnList agentId="a1" />);
    await screen.findByText('Run npm test');
    fireEvent.press(screen.getAllByLabelText('Take back')[0]);
    expect(await screen.findByText('That’s already gone.')).toBeTruthy();
    expect(screen.getByText('Run npm test')).toBeTruthy();
  });

  it('shows a plan’s time left from the Mac’s end time', () => {
    const plan = view.items.find((i) => i.kind === 'plan')!;
    expect(itemDetail(plan, plan.endsAt! - 42 * 60_000)).toBe(
      `${plan.detail} · ${timeLeftLine(plan.endsAt!, plan.endsAt! - 42 * 60_000)}`
    );
    expect(itemDetail({ ...plan, detail: undefined, endsAt: undefined }, 0)).toBeUndefined();
  });
});

describe('the team', () => {
  it('lists shared rules and each agent, a tap from its own list', async () => {
    await render(<OnItsOwnTeamList />);
    await screen.findByText('Rules for every agent');
    fireEvent.press(screen.getByText('Finance'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/on-its-own', params: { id: 'a1' } });
  });

  it('takes a shared rule back through the Chief', async () => {
    await render(<OnItsOwnTeamList />);
    await screen.findByText('Rules for every agent');
    fireEvent.press(screen.getByLabelText('Remove'));
    await waitFor(() =>
      expect(mockCall).toHaveBeenCalledWith('agents.onItsOwnNarrow', {
        agentId: 'chief',
        narrow: { kind: 'rule', ruleId: 't1' },
      })
    );
  });
});
