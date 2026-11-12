/**
 * The Projects tab shows an agent at work in a project: on that project's
 * card, with the step it's on, ahead of projects nobody is in; tapping it
 * opens its chat. A turn somewhere else, or an idle agent, isn't shown.
 */

import type { Agent, ProjectSummary, WelcomeFrame } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import Projects from '../src/app/(tabs)/projects/index';
import { setApp } from '../src/lib/store';
import { agent } from './helpers';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn() }),
  useFocusEffect: () => undefined,
  Stack: { Screen: () => null },
}));
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping', 'mass']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View: RN.View },
    FadeIn: preset,
    LinearTransition: preset,
    useAnimatedStyle: () => ({}),
    useSharedValue: (v: number) => ({ value: v }),
    withTiming: (v: number) => v,
  };
});
jest.mock('expo-haptics', () => ({}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
jest.mock('../src/lib/session', () => ({
  canCall: () => true,
  describeError: String,
  previewScreenshot: jest.fn(),
  refreshProjects: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/components/ConnectionPill', () => ({
  ConnectionBar: () => null,
  LinkProblem: () => null,
  useNow: () => 0,
}));
jest.mock('../src/components/agent', () => ({ Spinner: () => null }));
jest.mock('../src/components/AgentKey', () => ({ AgentKey: () => null }));
jest.mock('../src/components/session', () => ({
  SessionState: () => null,
  useTaskName: () => 'Claude Code 1',
}));

const SITE = '/Users/sam/Desktop/Projects/lumen-site';
const ACME = '/Users/sam/ShipStudio/acme-marketing';

const project = (path: string, name: string): ProjectSummary =>
  ({ path, name, dirtyFiles: 0, sessions: [] }) as unknown as ProjectSummary;

const working = (id: string, name: string, at: string | undefined): Agent =>
  agent({
    id,
    name,
    status: {
      state: 'working',
      activity: 'Running the build',
      since: 0,
      work: {
        startedAt: 0,
        stepCount: 2,
        steps: [],
        fileCount: 0,
        project: at,
        current: {
          kind: 'command',
          label: 'Running the build',
          startedAt: 0,
          streams: false,
          canStop: false,
        },
      },
    },
  });

function state(agents: Agent[]) {
  setApp({
    overview: { agents, engineReady: true, engines: [] } as never,
    link: { kind: 'connected' } as never,
    welcome: { methods: ['projects.list'] } as unknown as WelcomeFrame,
    projects: [project(ACME, 'acme-marketing'), project(SITE, 'lumen-site')],
    chats: {},
  });
}

beforeEach(() => mockPush.mockClear());

it('shows the agent and its step on the project it works in, first, and opens its chat', async () => {
  state([working('juno', 'Juno', SITE), agent({ id: 'idle', name: 'Idle One' })]);
  await render(<Projects />);
  const names = screen.getAllByText(/^(acme-marketing|lumen-site)$/).map((n) => n.props.children);
  expect(names).toEqual(['lumen-site', 'acme-marketing']);
  expect(screen.getByText('Juno')).toBeTruthy();
  expect(screen.getByText('Running the build')).toBeTruthy();
  expect(screen.queryByText('Idle One')).toBeNull();
  fireEvent.press(screen.getByLabelText('Juno, Running the build. Open its chat'));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/chat/[id]', params: { id: 'juno' } });
});

it('shows nobody for a turn the Mac reports in no project', async () => {
  state([working('mo', 'Mo', undefined)]);
  await render(<Projects />);
  expect(screen.queryByText('Mo')).toBeNull();
  expect(screen.getAllByText('Nothing running here')).toHaveLength(2);
});
