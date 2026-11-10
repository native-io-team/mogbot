/**
 * The chat header's usage meter is the desk's static one: an outline with
 * what is left as a pie inside it, never a thin arc (which read as a
 * spinner).
 */

import { render, screen } from '@testing-library/react-native';
import { piePath, UsageRing } from '../src/components/usage';

describe('the usage meter', () => {
  it('draws what is left as a pie from twelve o’clock', () => {
    expect(piePath(10, 10, 6, 0)).toBeNull();
    expect(piePath(10, 10, 6, 0.25)).toBe('M 10 10 L 10 4 A 6 6 0 0 1 16 10 Z');
    // More than half takes the long way round.
    expect(piePath(10, 10, 6, 0.75)).toContain(' 0 1 1 ');
    // All of it is a whole disc, not a zero-length arc.
    expect(piePath(10, 10, 6, 1)).toContain('A 6 6 0 1 1 16 10 A 6 6 0 1 1 4 10');
  });

  it('says what is left, and has no arc stroke to spin', async () => {
    await render(<UsageRing percent={30} tone="calm" onPress={() => {}} />);
    expect(screen.getByLabelText('Usage: 70% of the 5-hour limit left')).toBeTruthy();
    expect(screen.getByTestId('usage-meter')).toBeTruthy();
  });
});
