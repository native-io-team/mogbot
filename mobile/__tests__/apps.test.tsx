/**
 * "Apps your agents can use" on the phone (`app/apps.tsx`): the desk's
 * dialog through the companion protocol, in the desk's words. Drawn from the
 * Mac's own serde output (`fixtures.gen.ts`).
 */

import type { AppsOverview } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import {
  anySigningIn,
  appFlowLine,
  appSections,
  appWay,
  grantNote,
  grantsLine,
  grantsOf,
  keptWhere,
} from '../src/lib/apps';
import { setApp } from '../src/lib/store';

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
jest.mock('expo-haptics', () => ({}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ agentId: 'a1' }),
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
const choices: { title?: string; labels: string[]; run: (i: number) => void }[] = [];
jest.mock('../src/components/menu', () => ({
  choose: (title: string, cs: { label: string; run: () => void }[]) =>
    choices.push({ title, labels: cs.map((c) => c.label), run: (i: number) => cs[i]!.run() }),
}));
const calls: [string, unknown][] = [];
let mockOverview: AppsOverview;
jest.mock('../src/lib/session', () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  currentTransport: () => null,
  call: (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === 'agents.apps') return Promise.resolve(structuredClone(mockOverview));
    if (method === 'agents.appsSetGrants') {
      const p = params as { connectionId: string; grants: unknown[] };
      return Promise.resolve({ ...mockOverview.connections[1], grants: p.grants });
    }
    return Promise.resolve(null);
  },
}));
jest.mock('../src/lib/logins', () => ({
  CLAUDE_AI_CONNECTORS: 'https://claude.ai/customize/connectors',
  hasSignInSheet: () => false,
  openHere: jest.fn(() => Promise.resolve()),
  webBrowserModule: () => null,
}));

// eslint-disable-next-line import/first
import Apps from '../src/app/apps';

const fixture = real.agentsApps as AppsOverview;
const names = new Map([
  ['a1', 'Finance'],
  ['chief', 'Chief of Staff'],
]);

beforeEach(() => {
  calls.length = 0;
  choices.length = 0;
  // Nothing under way: the screen doesn't poll in these tests.
  mockOverview = { ...structuredClone(fixture), flows: [] };
  setApp({
    link: { kind: 'connected', route: 'tailscale' } as never,
    overview: {
      agents: [
        { id: 'chief', name: 'Chief of Staff', isMain: true },
        { id: 'a1', name: 'Finance', isMain: false },
      ],
    } as never,
    welcome: { methods: ['agents.apps', 'agents.appsConnect'], features: [] } as never,
  });
});

describe('the words, shared with the desk', () => {
  it('say who can use a connection and where its sign-in is kept', () => {
    const linear = fixture.connections.find((c) => c.service === 'linear')!;
    expect(grantsLine(linear, names)).toBe(
      'Finance can read and change (asks first); Chief of Staff can read'
    );
    expect(grantsLine({ grants: [] }, names)).toBe('No agent can use it yet');
    expect(keptWhere('oauth')).toBe('Signed in on this Mac');
    expect(keptWhere('gh')).toBe('GitHub CLI on this Mac');
    expect(keptWhere('claude_ai')).toBe('Connected on claude.ai');
    expect(grantNote('full', false)).toBe('Every change asks you on a card first.');
    expect(grantNote('read', true)).toContain('No agent ticked');
  });

  it('list connections first, then the apps still to connect, and poll only while signing in', () => {
    const s = appSections(fixture);
    expect(s.connected.map((c) => c.service)).toEqual(['gmail', 'linear', 'github']);
    // Linear is connected, so it isn't offered again; Notion and Figma are signing in.
    expect(s.toConnect.map((a) => a.service)).not.toContain('linear');
    expect(s.toConnect.map((a) => a.service)).toEqual(
      expect.arrayContaining(['notion', 'figma', 'stripe'])
    );
    expect(anySigningIn(fixture)).toBe(true);
    expect(anySigningIn({ ...fixture, flows: [] })).toBe(false);
  });

  it('say where a sign-in is, and never hand the phone the Mac’s own page', () => {
    const notion = fixture.flows.find((f) => f.service === 'notion')!;
    const figma = fixture.flows.find((f) => f.service === 'figma')!;
    expect(notion.flow?.url).toBeUndefined();
    expect(appFlowLine(notion, 'Notion')).toBe('Finish signing in on your Mac — it’s open there.');
    expect(appFlowLine(figma, 'Figma')).toBe(figma.flow!.message);
    expect(appWay(true, true)).toBe('sheet');
    expect(appWay(true, false)).toBe('mac');
    expect(appWay(false, true)).toBe('mac');
    expect(grantsOf(['a1', 'chief'], 'read')).toEqual([
      { agentId: 'a1', access: 'read' },
      { agentId: 'chief', access: 'read' },
    ]);
  });
});

describe('the apps screen', () => {
  it('lists each connection with its account, where it’s kept, who uses it and Needs sign-in', async () => {
    await render(<Apps />);
    await screen.findByText('Linear · sam@acme.com');
    expect(
      screen.getByText(
        'Signed in on this Mac · Finance can read and change (asks first); Chief of Staff can read'
      )
    ).toBeTruthy();
    expect(screen.getByText('Gmail · work@acme.com')).toBeTruthy();
    expect(screen.getByText('Connected on claude.ai · No agent can use it yet')).toBeTruthy();
    expect(screen.getAllByText('Needs sign-in').length).toBe(1);
    // Ours can be signed in again; claude.ai's and GitHub's can't from here.
    expect(screen.getAllByText('Sign in again').length).toBe(1);
    expect(screen.getByText('Gmail, Google Calendar, Slack and more')).toBeTruthy();
  });

  it('narrows who can use it as the user’s own answer, with one access for all ticked', async () => {
    await render(<Apps />);
    await screen.findByText('Linear · sam@acme.com');
    // The second connection's "Who can use it" (Linear's).
    await fireEvent.press(screen.getAllByText('Who can use it')[1]!);
    expect(screen.getByText('Which agents can use it?')).toBeTruthy();
    // Starts on what it has: both ticked, and full because someone has it.
    expect(screen.getByText('Every change asks you on a card first.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Chief of Staff'));
    await fireEvent.press(screen.getByText('Read only'));
    await fireEvent.press(screen.getByText('Save'));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'agents.appsSetGrants',
        { connectionId: 'c2', grants: [{ agentId: 'a1', access: 'read' }] },
      ])
    );
  });

  it('asks before Remove, and says what removing does', async () => {
    await render(<Apps />);
    await screen.findByText('Linear · sam@acme.com');
    await fireEvent.press(screen.getAllByText('Remove')[1]!);
    expect(choices).toHaveLength(1);
    expect(choices[0]!.title).toBe('Remove Linear?');
    expect(choices[0]!.labels).toEqual(['Remove']);
    expect(calls.some(([m]) => m === 'agents.appsRemove')).toBe(false);
    choices[0]!.run(0);
    await waitFor(() =>
      expect(calls).toContainEqual(['agents.appsRemove', { connectionId: 'c2' }])
    );
  });

  it('connects for the agent it was opened for, on the Mac when this build has no sheet', async () => {
    await render(<Apps />);
    await screen.findByText('Linear · sam@acme.com');
    await fireEvent.press(within(screen.getByTestId('app-stripe')).getByText('Connect'));
    expect(screen.getByText('Stripe’s sign-in opens on your Mac. Finish there.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Sign in to Stripe'));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'agents.appsConnect',
        { service: 'stripe', grants: [{ agentId: 'a1', access: 'read' }] },
      ])
    );
  });
});
