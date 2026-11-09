/**
 * "What can this agent do on its own?" on the desk: what the Mac really sends
 * (the generated fixture) drawn as plain lines grouped by section, each
 * narrow one tap that hands the Mac exactly that narrow, nothing that gives,
 * and Settings → Agents' team view opening an agent in place. Fictional
 * agents throughout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  agentsOnItsOwn,
  agentsOnItsOwnTeam,
} from '../../../packages/companion-protocol/src/fixtures.gen';
import type { OnItsOwn, OnItsOwnTeam } from '../../lib/agentOnItsOwn';
import {
  narrowLabel,
  onItsOwnSections,
  onItsOwnTeamRowLine,
  timeLeftLine,
} from '../../../packages/companion-protocol/src/onItsOwn';

const api = vi.hoisted(() => ({
  agentOnItsOwn: vi.fn(),
  teamOnItsOwn: vi.fn(),
  narrowOnItsOwn: vi.fn(),
}));
vi.mock('../../lib/agentOnItsOwn', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentOnItsOwn')>()),
  ...api,
}));
const AGENTS = [
  { id: 'a1', name: 'Finance', isMain: false },
  { id: 'chief', name: 'Chief of Staff', isMain: true },
];
const STATE = { agents: AGENTS };
vi.mock('../../lib/agentsStore', () => ({
  useAgentsSelector: <T,>(sel: (s: typeof STATE) => T) => sel(STATE),
}));

import { AgentOnItsOwnModal, OnItsOwnTeamSettings } from './AgentOnItsOwn';

const view = agentsOnItsOwn as unknown as OnItsOwn;
const team = agentsOnItsOwnTeam as unknown as OnItsOwnTeam;

beforeEach(() => {
  api.agentOnItsOwn.mockReset().mockResolvedValue(view);
  api.teamOnItsOwn.mockReset().mockResolvedValue(team);
  api.narrowOnItsOwn.mockReset().mockImplementation((_id: string, n: unknown) =>
    Promise.resolve({
      ...view,
      items: view.items.filter(
        (i) => !i.narrow.some((x) => JSON.stringify(x) === JSON.stringify(n))
      ),
    })
  );
});

describe('the words', () => {
  it('groups items in a fixed order and leaves empty sections out', () => {
    const sections = onItsOwnSections(view.items).map((s) => s.title);
    expect(sections).toEqual(['Rules', 'Plans you OK’d', 'Apps', 'Browser', 'Team and accounts']);
    expect(onItsOwnSections([])).toEqual([]);
  });

  it('says time left from the Mac’s end time, never past zero', () => {
    expect(timeLeftLine(1_000 + 42 * 60_000, 1_000)).toBe('42 min left');
    expect(timeLeftLine(90 * 60_000, 0)).toBe('1 hr 30 min left');
    expect(timeLeftLine(0, 5)).toBe('Ending now');
  });

  it('names every narrow as taking something away', () => {
    for (const item of view.items) {
      for (const n of item.narrow) {
        expect(['Remove', 'Read only', 'Take back', 'Turn off', 'Ask first']).toContain(
          narrowLabel(n)
        );
      }
    }
    expect(
      onItsOwnTeamRowLine({ agentId: 'x', name: 'X', level: 'often', ownLevel: true, standing: 0 })
    ).toBe('Careful (its own) · nothing beyond its level');
  });
});

describe('AgentOnItsOwnModal', () => {
  it('shows its level, what always asks and every standing item from the Mac', async () => {
    render(<AgentOnItsOwnModal agentId="a1" onClose={() => {}} />);
    expect(await screen.findByText('Unleashed · its own level')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'What can Finance do on its own?' })).toBeTruthy();
    expect(screen.getByText(view.levelLine)).toBeTruthy();
    for (const line of view.alwaysAsks) expect(screen.getByText(line)).toBeTruthy();
    for (const item of view.items) expect(screen.getByText(item.text)).toBeTruthy();
    // The account it spends is shown with no button.
    const account = screen.getByText(/^Spends only your Work account/).closest('li')!;
    expect(within(account).queryByRole('button')).toBeNull();
  });

  it('narrows in one tap, with exactly the narrow offered, and redraws', async () => {
    render(<AgentOnItsOwnModal agentId="a1" onClose={() => {}} />);
    const gmail = (await screen.findByText('Uses Gmail (work@acme.com)')).closest('li')!;
    fireEvent.click(within(gmail).getByRole('button', { name: /^Read only:/ }));
    await waitFor(() =>
      expect(api.narrowOnItsOwn).toHaveBeenCalledWith('a1', {
        kind: 'app_read_only',
        connectionId: 'c1',
      })
    );
    await waitFor(() => expect(screen.queryByText('Uses Gmail (work@acme.com)')).toBeNull());
  });

  it('shows the Mac’s refusal and keeps the list', async () => {
    api.narrowOnItsOwn.mockRejectedValueOnce({ kind: 'Expected', message: 'That’s already gone.' });
    render(<AgentOnItsOwnModal agentId="a1" onClose={() => {}} />);
    const rule = (await screen.findByText('Run npm test')).closest('li')!;
    fireEvent.click(within(rule).getByRole('button', { name: 'Remove: Run npm test' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Run npm test')).toBeTruthy();
  });
});

describe('OnItsOwnTeamSettings', () => {
  it('lists the team, its shared rules, and opens an agent in place', async () => {
    render(<OnItsOwnTeamSettings />);
    const row = await screen.findByRole('button', { name: /Finance/ });
    expect(screen.getByText('Rules for every agent')).toBeTruthy();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(await screen.findByText('Unleashed · its own level')).toBeTruthy();
    expect(api.agentOnItsOwn).toHaveBeenCalledWith('a1');
  });

  it('takes a team rule back through the Chief', async () => {
    render(<OnItsOwnTeamSettings />);
    const shared = await screen.findByRole('region', { name: 'Rules for every agent' });
    fireEvent.click(within(shared).getAllByRole('button', { name: /^Remove:/ })[0]);
    await waitFor(() =>
      expect(api.narrowOnItsOwn).toHaveBeenCalledWith('chief', { kind: 'rule', ruleId: 't1' })
    );
  });
});
