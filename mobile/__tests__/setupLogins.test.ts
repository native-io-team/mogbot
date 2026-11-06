/**
 * The setup card's Logins step on the phone: rows named by the app, never a
 * raw key, and "What your team needs" scoped to the agents being set up.
 */

import type { TeamLogins, TeamSetupLogin } from '@shipstudio/companion-protocol';
import { scopeTeam } from '../src/lib/logins';

jest.mock('../src/lib/session', () => ({ call: jest.fn(), currentTransport: () => null }));
import { groupLogins, humanise } from '../src/lib/teamSetup';

const l = (name: string, extra: Partial<TeamSetupLogin> = {}): TeamSetupLogin => ({
  agentId: 'a',
  agentName: 'Mailroom',
  requestId: name,
  name,
  purpose: '',
  ...extra,
});

describe('the setup card’s logins', () => {
  it('names each row by its app, grouped by service, accounts counted', () => {
    const rows = groupLogins([
      l('gmail_personal', { title: 'Gmail', group: 'google', family: 'Google' }),
      l('gmail_shop', { title: 'Gmail', group: 'google', family: 'Google' }),
      l('code_one', { title: 'GitHub', group: 'github' }),
      l('code_two', { title: 'GitHub', group: 'github' }),
      l('email_drafts'),
    ]);
    expect(rows.map((r) => r.name)).toEqual([
      'Google — Gmail (2 accounts)',
      'GitHub (2 accounts)',
      'Email drafts',
    ]);
  });

  it('reads an unknown key as words, from an older Mac too', () => {
    expect(humanise('slack_workspaces')).toBe('Slack workspaces');
    expect(humanise('ledgerApp_owner')).toBe('Ledger app owner');
    // Known names as their makers write them (login-names.json, shared with the Mac).
    expect(humanise('crm')).toBe('CRM');
    expect(humanise('github_workshop')).toBe('GitHub workshop');
    expect(groupLogins([l('travel_portal')])[0].name).toBe('Travel portal');
  });

  it('scopes What your team needs to these agents; a Connect skips the rest', () => {
    const card = (agentId: string) => ({
      agentId,
      agentName: agentId,
      requestId: `r-${agentId}`,
      service: 'gmail',
      title: 'Gmail',
      abilities: [],
      state: 'waiting' as const,
    });
    const team: TeamLogins = {
      needs: [
        {
          key: 'google',
          title: 'Google',
          services: ['gmail'],
          options: [],
          cards: [card('m'), card('x')],
          done: false,
        },
        { key: 'x', title: 'X', services: ['x'], options: [], cards: [card('x')], done: false },
      ],
      done: 0,
      total: 2,
    };
    const s = scopeTeam(team, new Set(['m']));
    expect(s.total).toBe(1);
    expect(s.needs[0].hidden).toEqual(['x']);
  });
});
