/**
 * The chat header's usage meter says what is used as a figure: a pie in a
 * circle read as the appearance toggle at half, a thin arc as a spinner.
 */

import { render, screen } from '@testing-library/react-native';
import { UsageRing } from '../src/components/usage';

describe('the usage meter', () => {
  it('says what is used, as a figure', async () => {
    await render(<UsageRing percent={30.4} tone="calm" onPress={() => {}} />);
    expect(screen.getByLabelText('Usage: 30% of the 5-hour limit used')).toBeTruthy();
    expect(screen.getByTestId('usage-meter')).toHaveTextContent('30%');
  });

  it('never says more than all of it', async () => {
    await render(<UsageRing percent={130} tone="limited" onPress={() => {}} />);
    expect(screen.getByTestId('usage-meter')).toHaveTextContent('100%');
  });
});
