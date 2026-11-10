/**
 * Every icon a key can wear, on the phone (components/KeyIconSheet.tsx): the
 * look's row keeps a pack icon in sight and offers the search; the pack
 * loads when the sheet opens, its icons drawn round-capped as Lucide drew
 * them, "money" finds the money keys and a tap picks one.
 *
 * One render of the sheet per file: its grid renders in batches after the
 * test, and a second render here would queue behind them.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { KeyIconSheet } from '../src/components/KeyIconSheet';
import { KeyChoices } from '../src/components/pickers';
import { setApp } from '../src/lib/store';

jest.mock('react-native-reanimated', () =>
  jest.requireActual<typeof import('./reanimatedStub')>('./reanimatedStub').reanimated()
);
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

beforeEach(() => setApp({ overview: null }));

/** The pack's first load (its index and every drawing) takes a moment in a test. */
const LOAD = { timeout: 20_000 };
jest.setTimeout(40_000);

it('the look keeps a pack icon in sight and offers the search', async () => {
  await render(
    <KeyChoices
      name="Finance"
      colorway="teal"
      icon="lucide:wallet"
      boundKey="F"
      taken={[]}
      onColorway={() => {}}
      onIcon={() => {}}
      onBoundKey={() => {}}
    />
  );
  expect(screen.getByLabelText('Wallet')).toBeTruthy();
  expect(screen.getByText('Search 2,029 more icons')).toBeTruthy();
});

it('the sheet finds icons by what they are for, and a tap picks one', async () => {
  const onPick = jest.fn();
  await render(
    <KeyIconSheet
      visible
      name="Finance"
      colorway="teal"
      icon="lucide:wallet"
      boundKey="F"
      onPick={onPick}
      onClose={() => {}}
    />
  );
  await waitFor(() => expect(screen.getByText('2,051 icons')).toBeTruthy(), LOAD);
  expect(screen.getByText('Wallet')).toBeTruthy();
  // Lucide's icons in round strokes (the native prop: round is 1, square 2).
  expect(JSON.stringify(screen.toJSON())).toContain('"strokeLinecap":1');
  await fireEvent.changeText(screen.getByLabelText('Search icons'), 'money');
  await waitFor(() => expect(screen.getByText(/for “money”/)).toBeTruthy());
  // The featured legend first, then the pack's.
  expect(screen.getByLabelText('Money')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Banknote'));
  expect(onPick).toHaveBeenCalledWith('lucide:banknote');
  await fireEvent.changeText(screen.getByLabelText('Search icons'), 'zzqx');
  await waitFor(() => expect(screen.getByText(/Nothing matches “zzqx”/)).toBeTruthy());
});
