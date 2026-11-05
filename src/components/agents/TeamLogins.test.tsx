import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { TeamLogins } from './TeamLogins';
import { ModalProvider } from '../../contexts/ModalContext';
import { AgentReach } from './AgentReach';
import { progressLine, waitingCards, type TeamLogins as Team } from '../../lib/agentLogins';
import type { Agent } from '../../lib/agents';

const card = (agentId: string, agentName: string, state = 'waiting') => ({
  agentId,
  agentName,
  requestId: `r-${agentId}`,
  service: 'github',
  title: 'GitHub',
  abilities: [{ id: 'read' as const, label: 'Read repositories' }],
  state: state as 'waiting',
});

const TEAM: Team = {
  needs: [
    {
      key: 'github',
      title: 'GitHub',
      services: ['github'],
      options: [{ id: 'gh', method: 'gh', label: 'Use GitHub on this Mac', detail: 'gh.' }],
      cards: [card('site', 'Site'), card('docs', 'Docs'), card('release', 'Release')],
      done: false,
    },
    {
      key: 'google',
      title: 'Google · Gmail + Calendar',
      services: ['gmail', 'google_calendar'],
      options: [],
      cards: [card('recruiter', 'Recruiter', 'connected')],
      done: true,
    },
  ],
  done: 1,
  total: 2,
};

afterEach(() => clearMocks());

describe('team logins helpers', () => {
  it('counts rows, not cards', () => {
    expect(progressLine({ done: 4, total: 9 })).toBe('4 of 9 connected');
    expect(progressLine({ done: 2, total: 2 })).toBe('All 2 done');
    expect(waitingCards(TEAM.needs[0], new Set(['docs'])).map((c) => c.agentId)).toEqual([
      'site',
      'release',
    ]);
  });
});

describe('TeamLogins', () => {
  it('one row per app, every agent on it; one Connect for all of them minus the unticked', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return cmd === 'agents_logins_team' ? TEAM : null;
    });
    render(<TeamLogins since={1} />);
    await screen.findByText('1 of 2 connected');
    expect(screen.getByText('Used by Site, Docs and Release')).toBeInTheDocument();
    const connect = screen.getByRole('button', { name: 'Use GitHub on this Mac for 3' });
    expect(connect.className).toMatch(/strong/);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Docs' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use GitHub on this Mac for 2' }));
      await Promise.resolve();
    });
    expect(calls).toContainEqual([
      'agents_logins_connect',
      { key: 'github', optionId: 'gh', skip: ['docs'] },
    ]);
    // A done row is folded at the end.
    expect(screen.queryByText('Recruiter')).toBeNull();
  });

  it('Skip puts one agent’s card away', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return cmd === 'agents_logins_team' ? TEAM : null;
    });
    render(<TeamLogins />);
    await screen.findByText('Used by Site, Docs and Release');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip Site' }));
      await Promise.resolve();
    });
    expect(calls).toContainEqual([
      'agents_login_dismiss',
      { agentId: 'site', requestId: 'r-site' },
    ]);
  });
});

describe('TeamLogins — Not needed', () => {
  const OTHER = {
    key: 'other:acme bank',
    title: 'Acme Bank',
    services: ['other'],
    options: [],
    cards: [{ ...card('books', 'Bookkeeper'), service: 'other', title: 'Acme Bank' }],
    done: false,
  };
  const WITH_BANK: Team = { needs: [TEAM.needs[0], OTHER, TEAM.needs[1]], done: 1, total: 3 };

  it('every row offers Not needed beside its main action, even one nothing can connect', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'agents_logins_team') return WITH_BANK;
      if (cmd === 'agents_logins_not_needed')
        return { keys: ['other:acme bank'], line: 'Not connecting Acme Bank.', closed: 1 };
      return null;
    });
    render(<TeamLogins />);
    await screen.findByText('Used by Bookkeeper');
    const rows = screen.getAllByRole('button', { name: 'Not needed' });
    expect(rows).toHaveLength(2);
    await act(async () => {
      fireEvent.click(rows[1]);
      await Promise.resolve();
    });
    expect(calls).toContainEqual(['agents_logins_not_needed', { keys: ['other:acme bank'] }]);
  });

  it('Skip the rest declines every row still waiting', async () => {
    const calls: [string, unknown][] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'agents_logins_team') return WITH_BANK;
      if (cmd === 'agents_logins_not_needed')
        return { keys: ['github', 'other:acme bank'], line: 'Not connecting them.', closed: 4 };
      return null;
    });
    render(<TeamLogins />);
    await screen.findByText('Used by Bookkeeper');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip the rest' }));
      await Promise.resolve();
    });
    expect(calls).toContainEqual([
      'agents_logins_not_needed',
      { keys: ['github', 'other:acme bank'] },
    ]);
  });
});

describe('AgentReach — declined apps', () => {
  it('lists apps the user chose not to connect, each turned back on in one click', async () => {
    const calls: [string, unknown][] = [];
    const reach = {
      connections: [],
      secrets: [],
      blockedApps: [],
      declined: [{ key: 'other:acme bank', title: 'Acme Bank', declinedAt: 1 }],
    };
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'agents_reach') return reach;
      return { ...reach, declined: [] };
    });
    render(
      <ModalProvider>
        <AgentReach agent={{ id: 'books', name: 'Bookkeeper' } as Agent} />
      </ModalProvider>
    );
    await screen.findByText('Acme Bank');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn back on' }));
      await Promise.resolve();
    });
    expect(calls).toContainEqual([
      'agents_reach_remove',
      { agentId: 'books', removal: { kind: 'undecline', key: 'other:acme bank' } },
    ]);
    await waitFor(() => expect(screen.queryByText('Acme Bank')).toBeNull());
  });
});

describe('AgentReach', () => {
  it('lists what the agent can reach and removes each in one click', async () => {
    const calls: [string, unknown][] = [];
    const reach = {
      connections: [
        {
          connectionId: 'c1',
          service: 'gmail',
          title: 'Gmail',
          account: 'work@acme.com',
          access: 'full',
          kept: 'Connected on claude.ai',
          needsSignIn: false,
        },
      ],
      browser: {
        on: true,
        teamOn: true,
        ownOff: false,
        sites: ['www.linkedin.com'],
        helperInstalled: false,
      },
      secrets: [],
      blockedApps: [],
    };
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'agents_reach') return reach;
      return { ...reach, connections: [] };
    });
    render(
      <ModalProvider>
        <AgentReach agent={{ id: 'recruiter', name: 'Recruiter' } as Agent} />
      </ModalProvider>
    );
    await screen.findByText('Gmail · work@acme.com');
    expect(screen.getByText(/extension isn’t set up/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
      await Promise.resolve();
    });
    expect(calls).toContainEqual([
      'agents_reach_remove',
      { agentId: 'recruiter', removal: { kind: 'connection', connectionId: 'c1' } },
    ]);
    await waitFor(() => expect(screen.queryByText('Gmail · work@acme.com')).toBeNull());
  });
});
