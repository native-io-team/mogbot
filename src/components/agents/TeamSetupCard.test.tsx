import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SetupStep, TeamSetupView } from '../../lib/teamSetup';
import { quietAgentIds } from '../../lib/teamSetup';
import { TeamSetupCard } from './TeamSetupCard';
import { SET_ASIDE_OUTCOME } from './AgentChatItems';

const calls = vi.hoisted(() => ({
  step: vi.fn((_s: string, _st: string) => Promise.resolve()),
  routine: vi.fn((_a: string, _c: string, _on: boolean) => Promise.resolve()),
  hello: vi.fn((_a: string) => Promise.resolve({})),
  missing: vi.fn(() => Promise.resolve({})),
  dismiss: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/teamSetup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/teamSetup')>()),
  setTeamSetupStep: (s: string, st: string) => calls.step(s, st),
  setTeamSetupRoutine: (a: string, c: string, on: boolean) => calls.routine(a, c, on),
  sayHiFromSetup: (a: string) => calls.hello(a),
  askChiefAboutMissing: () => calls.missing(),
  dismissTeamSetup: () => calls.dismiss(),
}));

const logins: SetupStep = {
  id: 'logins',
  state: 'open',
  logins: [
    {
      agentId: 'f',
      agentName: 'Bookkeeper',
      requestId: 'l1',
      name: 'bankline',
      purpose: 'Payouts',
    },
  ],
};
const routines: SetupStep = {
  id: 'routines',
  state: 'open',
  routines: [
    {
      agentId: 's',
      agentName: 'Inbox Watch',
      checkInId: 'r1',
      when: 'every day at 08:20',
      what: 'Check the shop inbox',
      on: false,
    },
  ],
};
const missing: SetupStep = {
  id: 'missing',
  state: 'open',
  gaps: [{ agentId: 'f', agentName: 'Bookkeeper', lines: ['Tell me when to check invoices'] }],
};
const hello = (states: Array<'quiet' | 'working' | 'said_hi'>): SetupStep => ({
  id: 'hello',
  state: 'open',
  agents: states.map((state, i) => ({
    agentId: `a${i}`,
    agentName: ['Bookkeeper', 'Studio', 'Recruiting'][i],
    color: 'green',
    state,
  })),
});

const view = (steps: SetupStep[], extra: Partial<TeamSetupView> = {}): TeamSetupView => {
  const done = steps.filter((s) => s.state !== 'open').length;
  return {
    id: 's1',
    source: 'Grok Bot',
    steps,
    done,
    total: steps.length,
    current: steps.find((s) => s.state === 'open')?.id,
    complete: done === steps.length,
    agents: 16,
    ...extra,
  };
};

beforeEach(() => {
  Object.values(calls).forEach((c) => c.mockClear());
});

describe('TeamSetupCard', () => {
  it('counts steps, never requests, and opens on the first open step', () => {
    render(
      <TeamSetupCard
        view={view([{ ...logins, state: 'done', logins: [] }, routines, missing, hello(['quiet'])])}
        chief="Chief of Staff"
      />
    );
    expect(screen.getByText('Setting up your team')).toBeInTheDocument();
    expect(screen.getByText('3 steps left')).toBeInTheDocument();
    expect(
      screen.getByText(/agents from Grok Bot are here, quiet until you say hi/)
    ).toBeInTheDocument();
    // Done reads as its outcome; routines (the first open step) is expanded.
    expect(screen.getByText('Logins added')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Switch on routines/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText('Inbox Watch · every day at 08:20')).toBeInTheDocument();
    expect(screen.queryByText(/requests/)).not.toBeInTheDocument();
  });

  it('switches a routine on and finishes or skips a step', async () => {
    render(<TeamSetupCard view={view([routines, hello(['quiet'])])} chief="Chief of Staff" />);
    fireEvent.click(screen.getByRole('switch', { name: /Inbox Watch/ }));
    await waitFor(() => expect(calls.routine).toHaveBeenCalledWith('s', 'r1', true));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(calls.step).toHaveBeenCalledWith('routines', 'done'));
    fireEvent.click(screen.getByRole('button', { name: /Skip for now/ }));
    await waitFor(() => expect(calls.step).toHaveBeenCalledWith('routines', 'skipped'));
  });

  it('a skipped step can be opened again', async () => {
    render(
      <TeamSetupCard
        view={view([{ ...routines, state: 'skipped' }, hello(['quiet'])])}
        chief="Chief of Staff"
      />
    );
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Switch on routines/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open again' }));
    await waitFor(() => expect(calls.step).toHaveBeenCalledWith('routines', 'open'));
  });

  it('hands every gap to the Chief in one go', async () => {
    render(<TeamSetupCard view={view([missing, hello(['quiet'])])} chief="Chief of Staff" />);
    expect(screen.getByText('Tell me when to check invoices')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask Chief of Staff to sort these' }));
    await waitFor(() => expect(calls.missing).toHaveBeenCalledTimes(1));
  });

  it('says hi one at a time: the others wait while one replies', () => {
    render(
      <TeamSetupCard view={view([hello(['working', 'quiet', 'said_hi'])])} chief="Chief of Staff" />
    );
    const rows = screen.getAllByRole('listitem').filter((li) => li.dataset.hello);
    expect(within(rows[0]).getByText('Replying…')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: 'Say hi' })).toBeDisabled();
    expect(within(rows[2]).getByText('Said hi')).toBeInTheDocument();
  });

  it('says hi on a tap when nobody is replying', async () => {
    render(<TeamSetupCard view={view([hello(['quiet', 'quiet'])])} chief="Chief of Staff" />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Say hi' })[1]);
    await waitFor(() => expect(calls.hello).toHaveBeenCalledWith('a1'));
  });

  it('lists each login with whose it is', () => {
    render(<TeamSetupCard view={view([logins, hello(['quiet'])])} chief="Chief of Staff" />);
    expect(screen.getByText('bankline')).toBeInTheDocument();
    expect(screen.getByText('Bookkeeper')).toBeInTheDocument();
    expect(screen.getByText(/Keychain, never the chat/)).toBeInTheDocument();
  });

  it('finished, it is one line that can be hidden', async () => {
    render(
      <TeamSetupCard
        view={view([
          { ...routines, state: 'done' },
          { ...hello(['said_hi']), state: 'done' },
        ])}
        chief="Chief of Staff"
      />
    );
    expect(screen.getByText(/Your team is set up/)).toBeInTheDocument();
    expect(screen.queryByText('Setting up your team')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(calls.dismiss).toHaveBeenCalled());
  });
});

describe('groupLogins', () => {
  it('makes a login several agents use one row', async () => {
    const { groupLogins } = await import('../../lib/teamSetup');
    const l = (agentName: string, name: string) => ({
      agentId: agentName,
      agentName,
      requestId: `${agentName}-${name}`,
      name,
      purpose: '',
    });
    const groups = groupLogins([
      l('Bookkeeper', 'bankline'),
      l('Payroll', 'Bankline'),
      l('Recruiting', 'hirehub'),
    ]);
    expect(groups.map((g) => [g.name, g.items.length])).toEqual([
      ['bankline', 2],
      ['hirehub', 1],
    ]);
  });
});

describe('quietAgentIds', () => {
  it('is everyone not met yet, and nobody once it is finished', () => {
    const v = view([hello(['quiet', 'said_hi', 'working'])]);
    expect([...quietAgentIds(v)]).toEqual(['a0']);
    expect(quietAgentIds({ ...v, complete: true }).size).toBe(0);
    expect(quietAgentIds(null).size).toBe(0);
  });
});

describe('a request set aside', () => {
  it('reads as set aside, not as unanswered', () => {
    expect(SET_ASIDE_OUTCOME).toBe('Set aside · nothing ran');
  });
});
