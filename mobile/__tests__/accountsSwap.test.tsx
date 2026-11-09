/**
 * Swapping accounts from the phone, one change at a time: an arrow tapped
 * again while the first move is still on its way to the Mac does nothing
 * (it would build on an order the Mac hasn't settled), and the arrows say
 * they're off while it's busy.
 */

import { switcherView, type UsageAccount } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { AccountsSections } from '../src/components/accounts';
import { useAccounts, type AccountsState } from '../src/lib/accounts';
import { setApp } from '../src/lib/store';

const mockCall = jest.fn();
jest.mock('../src/lib/session', () => ({
  call: (...a: unknown[]) => mockCall(...a),
  canCall: () => true,
  describeError: (e: unknown) => String(e),
}));
// Read once, as the screen does on opening.
jest.mock('../src/lib/usePolling', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    usePolling: (fn: () => Promise<unknown>) => useEffect(() => void fn(), []),
  };
});

const acct = (id: string, name: string): UsageAccount => ({
  id,
  name,
  engine: 'claude',
  thisMac: id === 'default',
  signedIn: true,
  out: false,
});
const LIST = [acct('default', 'sam@example.com'), acct('w1', 'Work'), acct('p1', 'Personal')];

beforeEach(() => {
  mockCall.mockReset();
  setApp({ link: { kind: 'connected' } as never, welcome: null });
});

it('a second move while the first is on its way is ignored, and the first one lands', async () => {
  let land: (v: UsageAccount[]) => void = () => {};
  mockCall.mockImplementation((method: string) => {
    if (method === 'agents.accounts') return Promise.resolve(structuredClone(LIST));
    if (method === 'agents.accounts.reorder') return new Promise<UsageAccount[]>((r) => (land = r));
    return Promise.reject(new Error(`unexpected ${method}`));
  });
  const { result } = await renderHook(() => useAccounts({ room: false }));
  await act(async () => {});
  expect(result.current.accounts?.map((a) => a.id)).toEqual(['default', 'w1', 'p1']);

  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = result.current.move('claude', 0, 1);
  });
  // Shown at once, and busy.
  expect(result.current.accounts?.map((a) => a.id)).toEqual(['w1', 'default', 'p1']);
  expect(result.current.busy).toBe(true);
  await act(async () => {
    await result.current.move('claude', 1, 1);
  });
  const reorders = mockCall.mock.calls.filter((c) => c[0] === 'agents.accounts.reorder');
  expect(reorders).toHaveLength(1);
  await act(async () => {
    land([LIST[1], LIST[0], LIST[2]]);
    await first;
  });
  expect(result.current.busy).toBe(false);
  expect(result.current.accounts?.map((a) => a.id)).toEqual(['w1', 'default', 'p1']);
});

it('the arrows take no tap while a change is on its way', async () => {
  const move = jest.fn(async () => {});
  const s: AccountsState = {
    serves: true,
    accounts: LIST,
    view: switcherView(LIST, null, {}),
    canSwap: true,
    canReorder: true,
    error: null,
    busy: true,
    swapTo: jest.fn(async () => {}),
    move,
  };
  await render(<AccountsSections state={s} />);
  const later = screen.getByLabelText('Try sam@example.com later');
  expect(later.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  await fireEvent.press(later);
  expect(move).not.toHaveBeenCalled();
});
