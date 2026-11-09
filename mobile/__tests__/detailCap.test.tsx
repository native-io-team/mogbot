/**
 * A card that asks keeps Deny · Allow in reach: its detail is capped at a few
 * lines with "Show all" (lib/agents `capFields`, `DETAIL_LINES`), and a new
 * card landing near the newest line is brought into view (lib/follow
 * `revealsCard`).
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import { Command, Fields } from '../src/components/ApprovalCard';
import { DiffLines } from '../src/components/diff';
import { capFields, DETAIL_LINES } from '../src/lib/agents';
import { FAR, revealsCard } from '../src/lib/follow';

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
// The loops ask whether their screen is showing (lib/moving.ts).
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('../src/lib/session', () => ({
  answerApproval: jest.fn(),
  call: jest.fn(),
  describeError: String,
}));

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('capFields', () => {
  it('shows short fields whole, with nothing to expand', () => {
    const r = capFields(
      [
        ['To', 'sam@example.com'],
        ['Subject', 'Hi'],
      ],
      DETAIL_LINES
    );
    expect(r.clipped).toBe(false);
    expect(r.shown.map(([, , n]) => n)).toEqual([1, 1]);
  });

  it('cuts a long body to what the budget leaves, and says so', () => {
    const r = capFields(
      [
        ['To', 'sam@example.com'],
        ['Body', lines(30)],
      ],
      DETAIL_LINES
    );
    expect(r.clipped).toBe(true);
    // A label line each, then the body gets the rest.
    expect(r.shown).toEqual([
      ['To', 'sam@example.com', 1],
      ['Body', lines(30), DETAIL_LINES - 3],
    ]);
  });

  it('counts a long single line as the rows it wraps to', () => {
    expect(capFields([['Body', 'x'.repeat(2000)]], DETAIL_LINES).clipped).toBe(true);
  });

  it('leaves fields past the budget behind Show all', () => {
    const many = Array.from({ length: 10 }, (_, i): [string, string] => [`F${i}`, 'v']);
    const r = capFields(many, DETAIL_LINES);
    expect(r.clipped).toBe(true);
    expect(r.shown).toHaveLength(DETAIL_LINES / 2);
  });
});

describe('the expander', () => {
  it('caps a command at the line budget, then shows it all, then less', async () => {
    await render(<Command text={lines(20)} lines={DETAIL_LINES} />);
    expect(screen.queryByText(/line 9\b/)).toBeNull();
    await fireEvent.press(screen.getByText('Show all 20 lines'));
    expect(screen.getByText(/line 20/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Show less'));
    expect(screen.queryByText(/line 20/)).toBeNull();
  });

  it('offers nothing for a command that fits', async () => {
    await render(<Command text={lines(3)} lines={DETAIL_LINES} />);
    expect(screen.queryByText(/Show all/)).toBeNull();
  });

  it('caps fields and opens them whole', async () => {
    await render(<Fields fields={[['Body', lines(30)]]} lines={DETAIL_LINES} />);
    expect(screen.getByText(lines(30)).props.numberOfLines).toBe(DETAIL_LINES - 1);
    await fireEvent.press(screen.getByText('Show all'));
    expect(screen.getByText(lines(30)).props.numberOfLines).toBeUndefined();
  });

  it('caps a diff when asked', async () => {
    await render(<DiffLines lines={lines(20).split('\n')} cap={DETAIL_LINES} />);
    expect(screen.queryByText('line 9')).toBeNull();
    await fireEvent.press(screen.getByText('Show all 20 lines'));
    expect(screen.getByText('line 20')).toBeTruthy();
  });
});

describe('revealsCard', () => {
  it('brings a new card into view at or near the newest line', () => {
    expect(revealsCard(null, 'c1', 0)).toBe(true);
    expect(revealsCard('c0', 'c1', FAR)).toBe(true);
  });
  it('leaves you where you are when you scrolled back to read', () => {
    expect(revealsCard(null, 'c1', FAR + 1)).toBe(false);
  });
  it('does it once, and not for a card already there on opening', () => {
    expect(revealsCard('c1', 'c1', 0)).toBe(false);
    expect(revealsCard(undefined, 'c1', 0)).toBe(false);
    expect(revealsCard('c1', null, 0)).toBe(false);
  });
});
