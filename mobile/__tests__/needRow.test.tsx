/**
 * A logins row (`NeedRow`, "What your team needs" and the setup card's
 * Logins step): the service as the title, who uses it under it, one answer,
 * and "Not needed" as a quiet word, never a second button of the same weight.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import { NeedRow } from '../src/components/teamLogins';

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
jest.mock('../src/lib/session', () => ({ describeError: String }));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));

describe('a logins row', () => {
  it('reads service first, then who uses it, with one answer and quiet words', async () => {
    const connect = jest.fn();
    const skip = jest.fn();
    await render(
      <NeedRow
        title="Linear"
        subtitle="Used by Client Sites Dev, Site QA"
        primary={{ title: 'Connect Linear', onPress: connect }}
        secondary={[{ label: 'Not needed', muted: true, onPress: skip }]}
      />
    );
    expect(screen.getByRole('header').props.children).toBe('Linear');
    expect(screen.getByText('Used by Client Sites Dev, Site QA')).toBeTruthy();
    // One filled answer; "Not needed" is a word beside it, not a button of its own weight.
    expect(screen.getByTestId('need-answer')).toBeTruthy();
    const labels = screen
      .getAllByRole('button')
      .map((b) => (b.props as { accessibilityLabel?: string }).accessibilityLabel);
    expect(labels).toEqual([
      'Connect Linear',
      'Not needed',
    ]);
    expect(screen.getByTestId('need-words')).toBeTruthy();
    await fireEvent.press(screen.getByText('Not needed'));
    expect(skip).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText('Connect Linear'));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('draws no word line when there is nothing quiet to offer', async () => {
    await render(
      <NeedRow
        title="Wise"
        subtitle="Used by Finance"
        primary={{ title: 'Add', onPress: () => {} }}
      />
    );
    expect(screen.queryByTestId('need-words')).toBeNull();
  });
});
