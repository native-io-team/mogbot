import type { AgentMessage, Approval, SessionPrompt } from '@shipstudio/companion-protocol';
import { act, render, screen } from '@testing-library/react-native';
import { agentAccent, ANSWER, deriveAccent, LIGHT_ACCENT, switchColors } from '../src/lib/accent';
import { commandLine } from '../src/lib/agents';
import { BROADER, broaderCaption, moreMessage, promptAnswers } from '../src/lib/answers';
import { readBrand } from '../src/lib/brand';
import { agentTints, colors, contrast, luminance } from '../src/lib/theme';
import { PromptCard } from '../src/components/PromptCard';
import { ARM_MS, useArmed } from '../src/components/ApprovalCard';
import { Text } from 'react-native';
import { agent } from './helpers';

// Reanimated's own mock needs its native module; the card only needs views and entering presets.
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
jest.mock('../src/lib/session', () => ({ answerApproval: jest.fn(), describeError: String }));

describe('accent maths', () => {
  it('gives every agent colour an ink that reads on it', () => {
    for (const [key, hex] of Object.entries(agentTints)) {
      const a = agentAccent(key);
      expect(a.accent).toBe(hex);
      expect([colors.inkDark, colors.inkLight]).toContain(a.onAccent);
      // WCAG AA for the label on a primary button.
      expect(contrast(a.accent, a.onAccent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('picks the higher-contrast ink, and falls back to white for an unknown key', () => {
    expect(deriveAccent('#ffffff').onAccent).toBe(colors.inkDark);
    expect(deriveAccent('#000000').onAccent).toBe(colors.inkLight);
    expect(agentAccent('chartreuse').accent).toBe(colors.textWhite);
    expect(agentAccent(null).accent).toBe(colors.textWhite);
  });

  it('draws an approval’s Allow the same neutral near-white for every agent', () => {
    expect(ANSWER.accent).toBe(agentTints.white);
    expect(ANSWER.onAccent).toBe(colors.inkDark);
    // Not the error red, not the warning amber: an answer never borrows an outcome's colour.
    expect(ANSWER.accent).not.toBe(agentTints.red);
    expect(ANSWER.accent).not.toBe(agentTints.amber);
  });
});

describe('switch contrast', () => {
  it('darkens the thumb on a light accent, so on never looks like off', () => {
    const white = switchColors(agentAccent('white'), true);
    expect(luminance(agentTints.white)).toBeGreaterThan(LIGHT_ACCENT);
    expect(white.thumbColor).toBe(colors.inkDark);
    expect(contrast(white.thumbColor, white.trackColor.true)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the white thumb on a dark accent, and when off', () => {
    for (const key of Object.keys(agentTints)) {
      const off = switchColors(agentAccent(key), false);
      expect(off.thumbColor).toBe(colors.textWhite);
      expect(off.trackColor.false).toBe(colors.surfaceSelected);
    }
    expect(switchColors(agentAccent('blue'), true).thumbColor).toBe(colors.textWhite);
  });

  it('keeps the on thumb distinct from the track for every agent colour', () => {
    for (const key of Object.keys(agentTints)) {
      const on = switchColors(agentAccent(key), true);
      expect(contrast(on.thumbColor, on.trackColor.true)).toBeGreaterThan(1.5);
    }
  });
});

describe('prompt answers', () => {
  const prompt = (labels: [string, 'allow' | 'deny' | 'other'][]) =>
    ({ options: labels.map(([label, role]) => ({ label, role, keys: [] })) }) as Pick<
      SessionPrompt,
      'options'
    >;

  it('puts Deny | Allow first and everything broader behind ⋯', () => {
    const a = promptAnswers(
      prompt([
        ['Yes', 'allow'],
        ['Yes, allow all edits during this session', 'allow'],
        ['No, and tell Claude what to do differently', 'deny'],
      ])
    );
    expect(a.deny?.index).toBe(2);
    expect(a.allow?.index).toBe(0);
    expect(a.more.map((o) => o.index)).toEqual([1]);
    expect(a.listed).toEqual([]);
  });

  it('lists a plain menu’s options as they come', () => {
    const a = promptAnswers(
      prompt([
        ['Light', 'other'],
        ['Dark', 'other'],
      ])
    );
    expect(a.deny).toBeUndefined();
    expect(a.more).toEqual([]);
    expect(a.listed.map((o) => o.option.label)).toEqual(['Light', 'Dark']);
  });

  it('says what a broader answer covers', () => {
    expect(BROADER.test('Yes, and don’t ask again for npm test')).toBe(true);
    expect(BROADER.test('Yes')).toBe(false);
    expect(broaderCaption('Yes, allow all edits during this session')).toBe(
      'Lets it make edits without asking for the rest of this session.'
    );
    expect(broaderCaption("Yes, and don't ask again for npm test")).toBe(
      'Lets it do this without asking again, not just this once.'
    );
    expect(broaderCaption('Yes to all')).toBe('Covers more than this one request.');
    expect(moreMessage([])).toBeUndefined();
  });
});

describe('command previews', () => {
  it('says what a command does, in words', () => {
    expect(commandLine('cp -r export/icons public/')).toBe('Wants to copy files');
    expect(commandLine('cd acme-site && pnpm install')).toBe('Wants to install packages');
    expect(commandLine('NODE_ENV=production npm run build')).toBe(
      'Wants to run its “build” script'
    );
    expect(commandLine('git push origin main')).toBe('Wants to push commits');
    expect(commandLine('sudo rm -rf dist')).toBe('Wants to delete files');
    expect(commandLine('ffmpeg -i a.mov a.mp4')).toBe('Wants to run “ffmpeg”');
  });

  it('never names only the harmless start of a chain', () => {
    expect(commandLine('ls && rm -rf ~')).toBe('Wants to look through files, and more');
  });
});

describe('brand', () => {
  it('reads brand.json from the app config, with a neutral fallback', () => {
    expect(readBrand({ brand: { name: 'X', slug: 'x', repository: 'https://e.x' } })).toEqual({
      name: 'X',
      slug: 'x',
      repository: 'https://e.x',
    });
    expect(readBrand(undefined).repository).toBe('');
    expect(readBrand({ brand: { name: 3 } }).name).toBe('the desktop app');
  });
});

describe('PromptCard', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const sessionPrompt = {
    sessionId: 's1',
    project: '/Users/me/ShipStudio/acme-site',
    tab: 1,
    kind: 'permission',
    owner: { id: 'a', name: agent().name },
    options: [
      { label: 'Yes', role: 'allow', keys: ['1'] },
      { label: 'Yes, allow all edits during this session', role: 'other', keys: ['2'] },
      { label: 'No', role: 'deny', keys: ['3'] },
    ],
  } as unknown as SessionPrompt;
  const approval: Approval = {
    requestId: 'r1',
    title: 'Do you want to make this edit to Hero.tsx?',
    detail: '',
    status: 'pending',
    prompt: sessionPrompt,
  };
  const message = {
    id: 'm1',
    agentId: 'a',
    ts: 1,
    kind: 'approval',
    text: '',
    approval,
  } as AgentMessage;

  it('shows Deny | Allow in that order, and keeps the broader answer behind ⋯', async () => {
    await render(
      <PromptCard
        message={message}
        approval={approval}
        prompt={sessionPrompt}
        agent={agent()}
        onError={() => {}}
      />
    );
    await act(() => jest.advanceTimersByTime(ARM_MS + 50));
    const answers = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel as string);
    expect(answers).toEqual(['Deny', 'Allow', 'More answers']);
    expect(screen.queryByText('Yes, allow all edits during this session')).toBeNull();
  });
});

describe('useArmed', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function Probe({ layout }: { layout: string }) {
    return <Text testID="armed">{String(useArmed(true, layout))}</Text>;
  }
  const armed = () => screen.getByTestId('armed').props.children as string;

  it('goes inert again for a beat whenever the card’s layout changes', async () => {
    const view = await render(<Probe layout="full" />);
    expect(armed()).toBe('false');
    await act(() => jest.advanceTimersByTime(ARM_MS));
    expect(armed()).toBe('true');
    await view.rerender(<Probe layout="compact" />);
    // The same render that changes the layout disarms it: no live frame in between.
    expect(armed()).toBe('false');
    await act(() => jest.advanceTimersByTime(ARM_MS - 1));
    expect(armed()).toBe('false');
    await act(() => jest.advanceTimersByTime(1));
    expect(armed()).toBe('true');
  });
});
