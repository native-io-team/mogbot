import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentMessage, ConnectorCard, ImportPicks } from '../../lib/agents';
import type { ImportReview } from '../../lib/agents';
import { ImportReviewCard, lineDiff, PREVIEW_LINES } from './ImportReviewCard';

const apply = vi.fn((_a: string, _r: string, _p: ImportPicks) =>
  Promise.resolve({ agents: [], replaced: [], skipped: [], chiefNotes: false, routinesRefused: [] })
);
/** What `agents_import_review_current` answers: the card's agents, read again now. */
let current: () => Promise<ImportReview> = () => new Promise(() => {});
vi.mock('../../lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agents')>()),
  applyImportReview: (a: string, r: string, p: ImportPicks) => apply(a, r, p),
  currentImportReview: () => current(),
}));

const CARD: ConnectorCard = {
  kind: 'review',
  talkId: 't',
  source: 'Grok',
  review: {
    proposals: [
      {
        key: 'p1',
        name: 'Finance',
        role: 'Money',
        instructions: 'Log every expense.\nAsk before paying.',
        memory: '- Accountant is Lena',
        routines: [
          {
            when: 'every weekday at 9am',
            what: 'Check invoices',
            schedule: 'every weekday at 09:00',
          },
        ],
        logins: [{ name: 'bank_login', purpose: 'Reads statements', kind: 'password' }],
        clash: {
          agentId: 'f',
          name: 'Finance',
          role: 'Mine',
          instructions: 'My own rules.\nAsk before paying.',
          logins: ['STRIPE_KEY', 'GITHUB_TOKEN'],
          project: '/Users/me/ShipStudio/acme-site',
          activeRoutines: 2,
          rules: 1,
          conversation: true,
        },
      },
      {
        key: 'p2',
        name: 'Travel',
        role: 'Trips',
        instructions: 'Book trains.',
        memory: '',
        routines: [],
        logins: [],
      },
    ],
    chiefNotes: '- Prefers mornings',
  },
};

function message(status: 'pending' | 'allowed' | 'denied' | 'expired' = 'pending'): AgentMessage {
  return {
    id: 'm1',
    agentId: 'chief',
    ts: 0,
    kind: 'approval',
    text: '',
    approval: {
      requestId: 'r1',
      title: 'Bring in 2 agents from Grok',
      detail: '',
      status,
      choice: status === 'allowed' ? 'Imported Finance (from Grok), Travel' : undefined,
      connector: CARD,
    },
  } as AgentMessage;
}

describe('ImportReviewCard', () => {
  it('imports what is ticked, as copies by default, and leaves the Chief alone unless asked', async () => {
    apply.mockClear();
    render(<ImportReviewCard message={message()} card={CARD} chiefName="Ada" onAnswer={vi.fn()} />);
    expect(screen.getByText(/Only what’s ticked is created/)).toBeInTheDocument();
    // Ticked by default, with the instructions already in view; no jargon counts.
    expect(screen.getByRole('checkbox', { name: 'Import Finance' })).toBeChecked();
    expect(screen.getByLabelText('Finance’s instructions').textContent).toBe(
      'Log every expense.\nAsk before paying.'
    );
    expect(screen.queryByText(/chars of instructions/)).not.toBeInTheDocument();
    // A taken name comes in as a copy unless Replace is chosen.
    expect(screen.getByText('Finance (from Grok)')).toBeInTheDocument();
    expect(screen.getByText('Name taken here')).toBeInTheDocument();
    // The Chief's notes are off by default.
    expect(screen.getByRole('checkbox', { name: 'Add to Ada’s notes' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Travel' }));
    // The affirmative answer is neutral, as Allow is: never the accent.
    expect(screen.getByRole('button', { name: 'Import 1 agent' }).className).toMatch(
      /button--strong/
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 agent' }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith('chief', 'r1', {
        agents: [{ key: 'p1', replace: false }],
        chiefNotes: false,
      })
    );
  });

  it('replaces only when chosen, with every consequence shown first', async () => {
    apply.mockClear();
    render(<ImportReviewCard message={message()} card={CARD} chiefName="Ada" onAnswer={vi.fn()} />);
    fireEvent.click(screen.getByText('Finance (from Grok)'));
    expect(
      screen.getByText('Logins it asks for · on secure cards, never here')
    ).toBeInTheDocument();
    expect(screen.getByText('every weekday at 09:00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace your Finance' }));
    const said = screen.getByRole('list', { name: 'Replacing your Finance' }).textContent;
    for (const line of [
      'Its instructions become these. Its memory is kept.',
      'Its role becomes “Money” (now “Mine”).',
      'It starts a fresh conversation.',
      'Its 2 routines are paused.',
      'It’s no longer bound to acme-site.',
      'Its “Always allow” rule is removed.',
      'Its saved logins are removed: STRIPE_KEY, GITHUB_TOKEN.',
    ])
      expect(said).toContain(line);
    // Its logins go unless kept: off by default.
    const keep = screen.getByRole('checkbox', { name: 'Keep its saved logins' });
    expect(keep).not.toBeChecked();
    const diff = screen.getByLabelText('What changes');
    expect(diff.textContent).toContain('− My own rules.');
    expect(diff.textContent).toContain('+ Log every expense.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Add to Ada’s notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 agents' }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith('chief', 'r1', {
        agents: [
          { key: 'p1', replace: true, keepLogins: false, seen: CARD.review!.proposals[0].clash },
          { key: 'p2', replace: false },
        ],
        chiefNotes: true,
      })
    );
    apply.mockClear();
    fireEvent.click(keep);
    expect(screen.getByRole('list', { name: 'Replacing your Finance' }).textContent).toContain(
      'It keeps its saved logins: STRIPE_KEY, GITHUB_TOKEN.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 agents' }));
    await waitFor(() =>
      expect(apply.mock.calls[0][2].agents[0]).toMatchObject({ replace: true, keepLogins: true })
    );
  });

  it('long instructions show their first lines, then all of them on request', () => {
    const long = Array.from({ length: 20 }, (_, i) => `Rule ${i + 1}.`).join('\n');
    const card: ConnectorCard = {
      ...CARD,
      review: { proposals: [{ ...CARD.review!.proposals[1], instructions: long }] },
    };
    render(<ImportReviewCard message={message()} card={card} chiefName="Ada" onAnswer={vi.fn()} />);
    const shown = screen.getByLabelText('Travel’s instructions');
    expect(shown.textContent).toContain(`Rule ${PREVIEW_LINES}.`);
    expect(shown.textContent).not.toContain(`Rule ${PREVIEW_LINES + 1}.`);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 20 lines' }));
    expect(shown.textContent).toContain('Rule 20.');
  });

  it('lists the sandbox paths it marked and the tools it translated', () => {
    const card: ConnectorCard = {
      ...CARD,
      review: {
        proposals: [
          {
            ...CARD.review!.proposals[1],
            instructions:
              'Keep notes in /workspace/trips/ (from Grok — not on this Mac). Use x_search.',
            foreignPaths: ['/workspace/trips/'],
            foreignTools: [{ name: 'x_search' }, { name: 'confirm_push', here: 'push' }],
          },
        ],
      },
    };
    render(<ImportReviewCard message={message()} card={card} chiefName="Ada" onAnswer={vi.fn()} />);
    // The marked text is what's in view: what Import writes.
    expect(screen.getByLabelText('Travel’s instructions').textContent).toContain(
      '/workspace/trips/ (from Grok — not on this Mac)'
    );
    fireEvent.click(screen.getByText('Travel'));
    expect(
      screen.getByText('Paths from Grok that aren’t on this Mac · marked in its text')
    ).toBeInTheDocument();
    expect(screen.getByText('/workspace/trips/')).toBeInTheDocument();
    const tools = screen.getByText('Tools from Grok · what it uses here instead').parentElement!;
    expect(tools.textContent).toContain('x_search · not available here');
    expect(tools.textContent).toContain('confirm_push · push');
  });

  it('shows the agent as it is now, and a lookalike name as one', async () => {
    current = () =>
      Promise.resolve({
        proposals: [
          {
            ...CARD.review!.proposals[1],
            name: 'Ѕite',
            clash: { agentId: 's', name: 'Site', role: 'Mine', instructions: 'Edited since.' },
          },
        ],
      });
    render(<ImportReviewCard message={message()} card={CARD} chiefName="Ada" onAnswer={vi.fn()} />);
    expect(await screen.findByText('Looks like your Site')).toBeInTheDocument();
    current = () => new Promise(() => {});
  });

  it('Don’t import answers the card no; an answered card just says what happened', () => {
    const onAnswer = vi.fn(() => Promise.resolve());
    const { unmount } = render(
      <ImportReviewCard message={message()} card={CARD} chiefName="Ada" onAnswer={onAnswer} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Don’t import' }));
    expect(onAnswer).toHaveBeenCalledWith('r1', false);
    unmount();
    render(
      <ImportReviewCard
        message={message('allowed')}
        card={CARD}
        chiefName="Ada"
        onAnswer={vi.fn()}
      />
    );
    expect(screen.getByText('Imported Finance (from Grok), Travel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import/ })).not.toBeInTheDocument();
  });
});

describe('lineDiff', () => {
  it('refuses inputs too big to diff here, rather than freezing the window', () => {
    const many = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\n');
    expect(lineDiff(many, `${many}\nmore`)).toBeNull();
    expect(lineDiff('x'.repeat(30_000), 'y'.repeat(30_000))).toBeNull();
  });

  it('keeps shared lines and marks the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });
});
