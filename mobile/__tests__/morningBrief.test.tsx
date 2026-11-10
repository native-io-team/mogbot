/**
 * The morning brief on the phone: the Chief's message reads as headed
 * lists with a check's outside text as plain words (no link), and Settings
 * → Morning brief reads the Mac (nothing before it answers), offers the
 * common mornings and Off, writes with `agents.setMorningBrief`, and shows
 * nothing on a Mac that doesn't serve it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { briefLabel, isBriefText } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

const mockCall = jest.fn((method: string, params?: Record<string, unknown>) =>
  Promise.resolve(
    method === 'agents.morningBrief'
      ? real.agentsMorningBrief
      : { on: params?.on, at: params?.at, always: params?.always }
  )
);
jest.mock('../src/lib/session', () => ({
  call: (m: string, p?: Record<string, unknown>) => mockCall(m, p),
  describeError: (e: unknown) => String(e),
}));
const mockChoose = jest.fn();
jest.mock('../src/components/menu', () => ({
  choose: (...a: unknown[]) => mockChoose(...a),
}));
jest.mock('../src/lib/haptics', () => ({ haptic: { select: jest.fn(), error: jest.fn() } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve(true)) }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('../src/components/ui', () => {
  const { Text, Pressable, View } = jest.requireActual('react-native');
  return {
    tap: jest.fn(),
    Section: ({ title, footer, children }: { title: string; footer?: string; children: unknown }) => (
      <View>
        <Text>{title}</Text>
        {children as never}
        {footer ? <Text>{footer}</Text> : null}
      </View>
    ),
    Row: ({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) => (
      <Pressable accessibilityRole="button" onPress={onPress}>
        <Text>{label}</Text>
        {value ? <Text>{value}</Text> : null}
      </Pressable>
    ),
  };
});
const mockMethods = { list: ['agents.morningBrief', 'agents.setMorningBrief'] };
jest.mock('../src/lib/store', () => ({
  useServed: (m: string) => mockMethods.list.includes(m),
  useApp: (select: (s: unknown) => unknown) => select({ link: { kind: 'connected' } }),
}));

import { MorningBriefSetting } from '../src/components/MorningBriefSetting';
import { Markdown } from '../src/components/Markdown';

const BRIEF = [
  'Morning brief, Monday 9 November: 1 card waits for you, 2 routines today.',
  '',
  '**Waiting on you**',
  '- Browser Helper: Enter the code the portal sent',
  '',
  '**Your checks**',
  '- events on my calendar today (Google Calendar):',
  '  - Standup 9\\:30',
  '  - \\[Click me\\]\\(https\\://evil\\.example\\)',
].join('\n');

describe('the morning brief on the phone', () => {
  beforeEach(() => {
    mockCall.mockClear();
    mockChoose.mockClear();
    mockMethods.list = ['agents.morningBrief', 'agents.setMorningBrief'];
  });

  it('reads as headed lists, a check’s words plain', async () => {
    expect(isBriefText(BRIEF)).toBe(true);
    await render(<Markdown text={BRIEF} />);
    expect(screen.getByText('Waiting on you')).toBeTruthy();
    expect(screen.getByText('Your checks')).toBeTruthy();
    expect(screen.getByText('Standup 9:30', { exact: false })).toBeTruthy();
    expect(screen.getByText('[Click me](https://evil.example)', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the Mac’s time, and sets a morning or off from the sheet', async () => {
    await render(<MorningBriefSetting />);
    expect(await screen.findByText('08:00')).toBeTruthy();
    fireEvent.press(screen.getAllByText('Morning brief')[1]);
    const [title, choices] = mockChoose.mock.calls[0] as [
      string,
      { label: string; run: () => void }[],
    ];
    expect(title).toBe('Morning brief');
    expect(choices.map((c) => c.label)).toEqual([
      '06:30',
      '07:00',
      '07:30',
      '08:00',
      '08:30',
      '09:00',
      'Turn off',
    ]);
    // The one already set writes nothing.
    choices[3].run();
    expect(mockCall).not.toHaveBeenCalledWith('agents.setMorningBrief', expect.anything());
    await act(async () => {
      choices[2].run();
    });
    expect(mockCall).toHaveBeenCalledWith('agents.setMorningBrief', {
      on: true,
      at: 450,
      always: false,
    });
    expect(screen.getByText('07:30')).toBeTruthy();
  });

  it('is absent on a Mac that doesn’t serve it', async () => {
    mockMethods.list = [];
    await render(<MorningBriefSetting />);
    expect(screen.queryByText('Morning brief')).toBeNull();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('words the time as the desk does', () => {
    expect(briefLabel({ on: true, at: 450 })).toBe('07:30');
    expect(briefLabel({ on: false, at: 450 })).toBe('Off');
  });
});
