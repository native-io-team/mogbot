/**
 * Settings → Quiet hours on the phone: read from the Mac (nothing shown
 * before it answers), the common nights and Off offered, written with
 * `agents.setQuietHours`, and nothing at all on a Mac that doesn't serve it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { quietLabel } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

const mockCall = jest.fn((method: string, params?: { window?: unknown }) =>
  Promise.resolve(
    method === 'agents.quietHours' ? real.agentsQuietHours : { window: params?.window ?? null }
  )
);
jest.mock('../src/lib/session', () => ({
  call: (m: string, p?: { window?: unknown }) => mockCall(m, p),
  describeError: (e: unknown) => String(e),
}));
const mockChoose = jest.fn();
jest.mock('../src/components/menu', () => ({
  choose: (...a: unknown[]) => mockChoose(...a),
}));
jest.mock('../src/lib/haptics', () => ({ haptic: { select: jest.fn(), error: jest.fn() } }));
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
const mockMethods = { list: ['agents.quietHours', 'agents.setQuietHours'] };
jest.mock('../src/lib/store', () => ({
  useServed: (m: string) => mockMethods.list.includes(m),
  useApp: (select: (s: unknown) => unknown) => select({ link: { kind: 'connected' } }),
}));

import { QuietHoursSetting } from '../src/components/QuietHoursSetting';

describe('quiet hours on the phone', () => {
  beforeEach(() => {
    mockCall.mockClear();
    mockChoose.mockClear();
    mockMethods.list = ['agents.quietHours', 'agents.setQuietHours'];
  });

  it('shows what the Mac has, and sets a night or off from the sheet', async () => {
    await render(<QuietHoursSetting />);
    expect(await screen.findByText('22:00–07:00')).toBeTruthy();
    fireEvent.press(screen.getAllByText('Quiet hours')[1]);
    const [title, choices] = mockChoose.mock.calls[0] as [
      string,
      { label: string; run: () => void }[],
    ];
    expect(title).toBe('Quiet hours');
    expect(choices.map((c) => c.label)).toEqual([
      '21:00–07:00',
      '22:00–07:00',
      '23:00–07:00',
      '22:00–08:00',
      'Turn off',
    ]);
    // The one already set writes nothing.
    choices[1].run();
    expect(mockCall).not.toHaveBeenCalledWith('agents.setQuietHours', expect.anything());
    await act(async () => {
      choices[4].run();
    });
    expect(mockCall).toHaveBeenCalledWith('agents.setQuietHours', { window: null });
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('is absent on a Mac that doesn’t serve it', async () => {
    mockMethods.list = [];
    await render(<QuietHoursSetting />);
    expect(screen.queryByText('Quiet hours')).toBeNull();
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('words a window as the desk does', () => {
    expect(quietLabel({ start: 22 * 60, end: 7 * 60 })).toBe('22:00–07:00');
    expect(quietLabel(null)).toBe('Off');
  });
});
