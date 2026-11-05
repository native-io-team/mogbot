import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SetupLater, SetupStep } from '../../lib/teamSetup';
import { checkLine, residueLine } from '../../lib/teamSetup';
import { SetupReach } from './TeamSetupReach';

const calls = vi.hoisted(() => ({
  later: vi.fn((_k: string, _a: string) => Promise.resolve(null as unknown)),
  check: vi.fn(() => Promise.resolve(0)),
}));
vi.mock('../../lib/teamSetup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/teamSetup')>()),
  setupLater: (k: string, a: string) => calls.later(k, a),
  checkTeamReach: () => calls.check(),
}));

// A fictional import: three of five services reached.
const row = (key: string, title: string, extra: Partial<SetupLater>): SetupLater =>
  ({
    key,
    service: key,
    title,
    agents: ['Studio', 'Recruiting'],
    agentIds: ['s', 'r'],
    keyOnly: false,
    state: 'open',
    ...extra,
  }) as SetupLater;

const later: SetupLater[] = [
  row('figma', 'Figma', { state: 'reachable', via: 'your browser, signed in on www.figma.com' }),
  row('github', 'GitHub', {
    state: 'reachable',
    via: 'GitHub CLI on this Mac, signed in as sam-example',
  }),
  row('linkedin', 'LinkedIn', { action: 'Use my browser' }),
  row('other:bankline', 'Bankline', {
    service: 'other',
    action: 'Add a key for Bankline',
    keyOnly: true,
  }),
  row('notion', 'Notion', { state: 'not_needed' }),
];

const step = (extra: Partial<SetupStep> = {}): SetupStep => ({
  id: 'logins',
  state: 'open',
  later,
  check: { running: false, total: 5, checked: [], browser: true },
  ...extra,
});

describe('SetupReach', () => {
  beforeEach(() => {
    calls.later.mockClear();
    calls.check.mockClear();
  });

  it('shows one calm line while the check runs', () => {
    render(
      <SetupReach
        step={step({
          check: {
            running: true,
            total: 14,
            checked: [
              { title: 'Figma', reached: true },
              { title: 'GitHub', reached: true },
            ],
            browser: true,
          },
        })}
      />
    );
    expect(screen.getByTestId('team-setup-check')).toHaveTextContent(
      'Checking 14 services… Figma ✓ GitHub ✓'
    );
    expect(screen.queryByText('Not needed')).toBeNull();
  });

  it('shows only the residue, each with one button and Not needed', async () => {
    render(<SetupReach step={step()} />);
    expect(
      screen.getByText('Your team is ready. 2 things I couldn’t reach on this Mac:')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use my browser' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a key for Bankline' })).toBeInTheDocument();
    // Reached and decided rows aren't asked about.
    expect(screen.queryByText('Figma')).toBeNull();
    expect(screen.queryByText('Notion')).toBeNull();
    // Receipts fold into one line.
    fireEvent.click(screen.getByRole('button', { name: '2 reached on this Mac' }));
    expect(screen.getByTestId('team-setup-receipts')).toHaveTextContent(
      'Figma: your browser, signed in on www.figma.com'
    );
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Not needed' })[0]);
      await Promise.resolve();
    });
    expect(calls.later).toHaveBeenCalledWith('linkedin', 'not_needed');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use my browser' }));
      await Promise.resolve();
    });
    expect(calls.later).toHaveBeenCalledWith('linkedin', 'connect');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await Promise.resolve();
    });
    expect(calls.check).toHaveBeenCalled();
  });

  it('offers the browser once, before the check could use it', () => {
    render(
      <SetupReach
        step={step({ check: { running: false, total: 5, checked: [], browser: false } })}
      />
    );
    expect(
      screen.getByText(/use your signed-in browser to check what it can reach/)
    ).toBeInTheDocument();
  });

  it('words', () => {
    expect(residueLine([])).toMatch(/^Your team is ready\./);
    expect(checkLine({ running: false, total: 1, checked: [], browser: false })).toBe(
      'Checked 1 service.'
    );
  });
});
