import { switcherView, type UsageAccount } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AccountsSections, accountRowLines, shownEngines } from '../src/components/accounts';
import type { AccountsState } from '../src/lib/accounts';
import {
  headerSubtitle,
  headerSubtitleParts,
  idsOf,
  reordered,
  runsOnChoices,
} from '../src/lib/accountsView';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

jest.mock('../src/lib/session', () => ({
  call: jest.fn(),
  canCall: () => true,
  describeError: (e: unknown) => String(e),
}));

const NOW = 1_762_290_000_000;

const acct = (over: Partial<UsageAccount> & Pick<UsageAccount, 'id' | 'name'>): UsageAccount => ({
  engine: 'claude',
  thisMac: over.id === 'default',
  signedIn: true,
  out: false,
  ...over,
});

const mac = acct({ id: 'default', name: 'sam@example.com', email: 'sam@example.com', plan: 'Max' });
const work = acct({ id: 'w1', name: 'Work', email: 'me@work.example' });
const codex = acct({ id: 'default', engine: 'codex', name: 'Signed in on this Mac' });

const state = (accounts: UsageAccount[], over: Partial<AccountsState> = {}): AccountsState => ({
  serves: true,
  accounts,
  view: switcherView(accounts, null, {
    now: NOW,
    pins: [{ engine: 'claude', account: 'w1', name: 'QA 2' }],
  }),
  canSwap: true,
  canReorder: true,
  error: null,
  busy: false,
  swapTo: jest.fn(async () => {}),
  move: jest.fn(async () => {}),
  ...over,
});

describe('usage accounts, on the phone', () => {
  it('reads what a Mac really serves for agents.accounts', () => {
    const view = switcherView(real.agentsAccounts, null, { now: NOW });
    // This Mac's own Claude sign-in, unnamed, is shown as who it is.
    expect(view[0].rows.map((r) => r.name)).toEqual(['sam@example.com', 'Work']);
    expect(view[0].rows[0].inUse).toBe(true);
    // Codex has only this Mac's, signed out: nothing to show for it.
    expect(shownEngines(view).map((e) => e.engine)).toEqual(['claude']);
  });

  it('a swap reorders one engine and leaves the other alone', () => {
    const all = [mac, work, codex];
    const next = reordered(all, 'claude', ['w1', 'default']);
    expect(idsOf(next, 'claude')).toEqual(['w1', 'default']);
    expect(next[2]).toBe(codex);
    // A list that changed meanwhile is never half-applied.
    expect(reordered(all, 'claude', ['w1'])).toBe(all);
  });

  it('says each account in lines: who, its state and room, who runs only on it', () => {
    const [claude] = switcherView([mac, work], null, {
      now: NOW,
      pins: [{ engine: 'claude', account: 'w1', name: 'QA 2' }],
    });
    expect(accountRowLines(claude.rows[0])).toEqual([
      'Max plan · this Mac’s own sign-in',
      'In use',
    ]);
    expect(accountRowLines(claude.rows[1])).toEqual([
      'me@work.example',
      'Ready',
      'QA 2 runs only on this one',
    ]);
  });

  it('Use now and the arrows act on the row they sit on; adding is on the Mac', async () => {
    const s = state([mac, work, codex]);
    await render(<AccountsSections state={s} />);
    // Only the account not in use offers Use now.
    expect(screen.queryByLabelText('Use sam@example.com now')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Use Work now'));
    expect(s.swapTo).toHaveBeenCalledWith('claude', 'w1');
    // No arrow past either end.
    expect(screen.queryByLabelText('Try sam@example.com earlier')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Try sam@example.com later'));
    expect(s.move).toHaveBeenCalledWith('claude', 0, 1);
    expect(screen.getByText(/Add or sign in to accounts on your Mac/)).toBeTruthy();
    expect(screen.getByText('CLAUDE CODE ACCOUNTS')).toBeTruthy();
  });

  it('an older Mac that can’t take a swap shows the list without the controls', async () => {
    await render(
      <AccountsSections state={state([mac, work], { canSwap: false, canReorder: false })} />
    );
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.queryByLabelText('Use Work now')).toBeNull();
    expect(screen.queryByLabelText('Try Work earlier')).toBeNull();
  });

  it('a refusal is said under the list', async () => {
    await render(<AccountsSections state={state([mac, work], { error: 'Sign Work in first.' })} />);
    expect(screen.getByText('Sign Work in first.')).toBeTruthy();
  });

  it('Runs on is offered only with two accounts of the agent’s engine to pick between', () => {
    expect(runsOnChoices([mac, work, codex], 'claude').map((a) => a.id)).toEqual(['default', 'w1']);
    expect(runsOnChoices([mac, work, codex], 'codex')).toEqual([]);
    expect(runsOnChoices(null, 'claude')).toEqual([]);
  });

  it('the chat header names the account its last turn ran on, quietly', () => {
    expect(headerSubtitle({ role: 'Design system' })).toBe('Design system');
    expect(headerSubtitle({ role: 'Design system', ranOn: { id: 'w1', name: 'Work' } })).toBe(
      'Design system · on Work'
    );
    expect(headerSubtitle({ role: '', ranOn: { id: 'w1', name: 'Work' } })).toBe('On Work');
    expect(headerSubtitle({ role: '' })).toBe('');
    // In two parts, so the role gives way before the account.
    expect(
      headerSubtitleParts({ role: 'Design system', ranOn: { id: 'w1', name: 'Work' } })
    ).toEqual({ role: 'Design system', on: ' · on Work' });
    expect(headerSubtitleParts({ role: '', ranOn: { id: 'w1', name: 'Work' } })).toEqual({
      role: '',
      on: 'On Work',
    });
    expect(headerSubtitleParts({ role: 'Design system' })).toEqual({
      role: 'Design system',
      on: '',
    });
  });
});
