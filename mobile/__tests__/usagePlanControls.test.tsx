/**
 * Persona review 2026-11-09 (the Maximizer): the phone's Usage sheet changes
 * the usage mode, adds to the list of ideas for leftover usage and presses "Give agents
 * something to do" (`agents.usage.setMode`, `agents.spare.add`,
 * `agents.spare.spendNow`), and an older Mac's phone shows none of it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { UsageInventory } from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

const inventory = (over: Partial<UsageInventory> = {}): UsageInventory => ({
  ...(structuredClone(real.agentsUsagePlan) as UsageInventory),
  mode: 'normal',
  backlog: [
    { id: 's1', text: 'Write the changelog', addedBy: 'you', addedAt: 0, state: 'waiting' },
  ],
  ...over,
});

const mockCall = jest.fn((method: string, params?: Record<string, unknown>) =>
  Promise.resolve(
    method === 'agents.spare.spendNow'
      ? { line: 'Chief of Staff is starting your ideas for leftover usage (2 waiting).' }
      : inventory(method === 'agents.usage.setMode' ? { mode: params?.mode as never } : {})
  )
);
const mockServed = { list: ['agents.usage.setMode', 'agents.spare.add', 'agents.spare.spendNow'] };
jest.mock('../src/lib/session', () => ({
  call: (m: string, p?: Record<string, unknown>) => mockCall(m, p),
  canCall: (m: string) => mockServed.list.includes(m),
  describeError: (e: unknown) => String(e),
}));
jest.mock('../src/lib/haptics', () => ({ haptic: { light: jest.fn(), select: jest.fn() } }));
jest.mock('../src/components/ui', () => {
  const { Text, Pressable, View } = jest.requireActual('react-native');
  return {
    T: ({ children }: { children: unknown }) => <Text>{children as never}</Text>,
    SectionTitle: ({ title }: { title: string }) => <Text>{title}</Text>,
    Button: ({
      title,
      onPress,
      disabled,
    }: {
      title: string;
      onPress: () => void;
      disabled?: boolean;
    }) => (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        onPress={disabled ? undefined : onPress}
      >
        <Text>{title}</Text>
      </Pressable>
    ),
    Segmented: ({
      options,
      onChange,
    }: {
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
    }) => (
      <View>
        {options.map((o) => (
          <Pressable key={o.value} accessibilityRole="tab" onPress={() => onChange(o.value)}>
            <Text>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    ),
  };
});

import { servesUsageChanges, UsagePlanControls } from '../src/components/usagePlanControls';

beforeEach(() => {
  mockCall.mockClear();
  mockServed.list = ['agents.usage.setMode', 'agents.spare.add', 'agents.spare.spendNow'];
});

it('changes the mode, adds to the list and starts it from the phone', async () => {
  const onChanged = jest.fn();
  await render(<UsagePlanControls inventory={inventory()} onChanged={onChanged} />);
  await act(async () => {
    fireEvent.press(screen.getByText('Use it all'));
  });
  expect(mockCall).toHaveBeenCalledWith('agents.usage.setMode', { mode: 'use_it_all' });
  expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'use_it_all' }));

  await act(async () => {
    fireEvent.changeText(
      screen.getByLabelText('Add to your ideas for leftover usage'),
      '  Tidy the docs '
    );
  });
  await act(async () => {
    fireEvent.press(screen.getByText('Add'));
  });
  expect(mockCall).toHaveBeenCalledWith('agents.spare.add', { text: 'Tidy the docs' });
  expect(screen.getByText('Added to your ideas for leftover usage.')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByText('Give agents something to do'));
  });
  expect(mockCall).toHaveBeenCalledWith('agents.spare.spendNow', {});
  expect(
    screen.getByText('Chief of Staff is starting your ideas for leftover usage (2 waiting).')
  ).toBeTruthy();
});

it('choosing the mode already in force sends nothing', async () => {
  await render(<UsagePlanControls inventory={inventory({ mode: 'save' })} onChanged={jest.fn()} />);
  await act(async () => {
    fireEvent.press(screen.getByText('Save'));
  });
  expect(mockCall).not.toHaveBeenCalled();
  expect(screen.getByText(/^Save my limits: Routines wait/)).toBeTruthy();
});

it('an older Mac that does not serve the changes gets none of it', () => {
  mockServed.list = [];
  expect(servesUsageChanges()).toBe(false);
});
