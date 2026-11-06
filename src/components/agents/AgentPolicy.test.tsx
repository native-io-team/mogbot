/**
 * What each agent can do, on the desk: the "Change … settings?" card's body,
 * the editor's "What it can do" (what the Mac really sends: the generated
 * fixture), and Settings → Agents → What agents can do with its presets and
 * "Reset everyone". Fictional agents throughout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { agentsPolicy } from '../../../packages/companion-protocol/src/fixtures.gen';
import type { AgentPolicyView, TeamPolicyView } from '../../lib/agentPolicy';

const api = vi.hoisted(() => ({
  agentPolicy: vi.fn(),
  teamPolicy: vi.fn(),
  setPolicy: vi.fn(),
}));
vi.mock('../../lib/agentPolicy', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentPolicy')>()),
  ...api,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('../../lib/agentsStore', () => ({
  refreshAgents: vi.fn(() => Promise.resolve()),
  useAgentsList: () => [],
  agentIn: () => undefined,
  getAgentsSnapshot: () => ({ agents: [] }),
  subscribeAgents: () => () => {},
}));

import { AgentSettingsChange } from './AgentSettingsChange';
import { AgentPolicy } from './AgentPolicy';
import { AgentTeamPolicySettings } from './AgentTeamPolicySettings';
import type { Agent } from '../../lib/agents';

const finance = { id: 'a1', name: 'Finance' } as Agent;

const team: TeamPolicyView = {
  preset: 'balanced',
  presets: [
    { id: 'trusted', label: 'I trust my agents', blurb: 'Change projects directly.' },
    { id: 'balanced', label: 'Balanced', blurb: 'Its own copy.' },
    { id: 'locked', label: 'Locked down', blurb: 'Read projects only.' },
  ],
  lines: [
    { key: 'projects', label: 'Projects', value: 'Every project', enforced: 'app', team: true },
    {
      key: 'rules',
      label: 'Rules',
      value: '“Never email clients”',
      enforced: 'prompt',
      team: true,
    },
  ],
  team: {
    projects: { scope: 'all', how: 'copy', elsewhere: 'change' },
    folders: [],
    apps: { mode: 'all' },
    browser: true,
    rules: ['Never email clients'],
  },
  ownSettings: ['Hiring'],
};

beforeEach(() => {
  api.agentPolicy.mockReset().mockResolvedValue(agentsPolicy as AgentPolicyView);
  api.teamPolicy.mockReset().mockResolvedValue(team);
  api.setPolicy.mockReset().mockResolvedValue(undefined);
});

describe('AgentSettingsChange', () => {
  it('says who changes and how, why, and that a rule is only words', () => {
    render(
      <AgentSettingsChange
        proposal={{
          targets: [{ kind: 'agent', agentId: 'h' }],
          change: { browser: false, addRules: ['Never email clients'] },
          version: 3,
          groups: [
            {
              who: 'Hiring',
              agentIds: ['h'],
              changes: [
                'Can now work in client-site (its own copy)',
                'Can no longer use your browser',
              ],
            },
          ],
          why: 'You asked for Hiring on the client site',
          hasRules: true,
        }}
      />
    );
    const group = screen.getByRole('region', { name: 'Hiring' });
    expect(
      within(group).getByText('Can now work in client-site (its own copy)')
    ).toBeInTheDocument();
    expect(within(group).getByText('Can no longer use your browser')).toBeInTheDocument();
    expect(screen.getByText('Why: You asked for Hiring on the client site')).toBeInTheDocument();
    expect(screen.getByText(/the app doesn’t stop it breaking one/)).toBeInTheDocument();
  });
});

describe('AgentPolicy', () => {
  it('lists what the Mac sends, says which are its own and which are only instructions', async () => {
    render(<AgentPolicy agent={finance} />);
    await screen.findByText(
      'Every project · its own copy in client-site; changes the others directly'
    );
    const browser = document.querySelector('[data-key="browser"]')!;
    expect(browser).toHaveTextContent('Its own');
    const independence = document.querySelector('[data-key="independence"]')!;
    expect(independence).toHaveTextContent('Team default · instructions');
    // Its own rule can come off here; the team's can't.
    expect(screen.getByRole('button', { name: 'Remove from Rules' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove from Folders on this Mac' })
    ).toBeInTheDocument();
    expect(screen.getByText(/except independence and rules/)).toBeInTheDocument();
  });

  it('“Change in chat” drafts the request instead of sending it to Settings', async () => {
    const ask = vi.fn();
    render(<AgentPolicy agent={finance} onAskInChat={ask} />);
    await screen.findByText('What it can do');
    fireEvent.click(await screen.findByRole('button', { name: 'Change in chat' }));
    expect(ask).toHaveBeenCalledWith('Change what Finance can do: ');
  });

  it('a preset from the menu applies to this agent', async () => {
    render(<AgentPolicy agent={finance} />);
    const menu = await screen.findByRole('button', { name: 'Its own settings' });
    fireEvent.click(menu);
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Locked down' }));
    });
    expect(api.setPolicy).toHaveBeenCalledWith(
      { kind: 'agent', agentId: 'a1' },
      { preset: 'locked' }
    );
    await waitFor(() => expect(api.agentPolicy).toHaveBeenCalledTimes(2));
  });
});

describe('AgentTeamPolicySettings', () => {
  it('shows the presets, the team’s lines and who has its own settings', async () => {
    render(<AgentTeamPolicySettings />);
    expect(await screen.findByRole('radio', { checked: true })).toHaveTextContent('Balanced');
    expect(screen.getByText(/1 agent has settings of its own: Hiring/)).toBeInTheDocument();
    expect(screen.getByText(/just ask your Chief of Staff in chat/)).toBeInTheDocument();
  });

  it('a preset changes the team’s defaults; Reset everyone asks first', async () => {
    render(<AgentTeamPolicySettings />);
    const trusted = await screen.findByRole('radio', { name: /I trust my agents/ });
    await act(async () => {
      fireEvent.click(trusted);
      await Promise.resolve();
    });
    expect(api.setPolicy).toHaveBeenCalledWith(
      { kind: 'team', everyone: false },
      { preset: 'trusted' }
    );
    api.setPolicy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reset everyone to Balanced' }));
    expect(api.setPolicy).not.toHaveBeenCalled();
    expect(await screen.findByText(/Hiring lose their own settings/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset everyone' }));
      await Promise.resolve();
    });
    expect(api.setPolicy).toHaveBeenCalledWith(
      { kind: 'team', everyone: true },
      { preset: 'balanced' }
    );
  });
});
