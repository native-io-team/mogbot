import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});
import { act, fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ApprovalCard, ErrorLine, FreshHint, NoteLine } from './AgentChatItems';
import type { Agent, AgentMessage } from '../../lib/agents';
import { onSwitcherRequest } from '../../lib/agentAccounts';

const approvalMessage: AgentMessage = {
  id: 'm1',
  agentId: 'acme',
  ts: Date.now(),
  kind: 'approval',
  text: '',
  approval: { requestId: 'r1', title: 'Run a command', detail: 'npm test', status: 'pending' },
};

describe('ApprovalCard', () => {
  it('a request the Mac marked risky wears the warning icon; others don’t', () => {
    const risky: AgentMessage = {
      ...approvalMessage,
      approval: { ...approvalMessage.approval!, detail: 'rm -r ~/Exports/2024', risk: 'high' },
    };
    const { container, unmount } = render(
      <ApprovalCard message={risky} agentName="Acme" paused={false} onAnswer={vi.fn()} />
    );
    expect(container.querySelector('.agent-card__icon[data-tone="warning"]')).not.toBeNull();
    unmount();
    const low: AgentMessage = {
      ...approvalMessage,
      approval: { ...approvalMessage.approval!, risk: 'low' },
    };
    const again = render(
      <ApprovalCard message={low} agentName="Acme" paused={false} onAnswer={vi.fn()} />
    );
    expect(again.container.querySelector('.agent-card__icon[data-tone="warning"]')).toBeNull();
  });

  it('Deny is one click', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalCard message={approvalMessage} agentName="Acme" paused={false} onAnswer={onAnswer} />
    );
    expect(screen.getAllByRole('button', { name: /^deny/i })).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('r1', false, false, undefined);
  });

  it('a note for what to do instead is behind the card’s menu', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalCard message={approvalMessage} agentName="Acme" paused={false} onAnswer={onAnswer} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'More answers' }));
    fireEvent.click(await screen.findByText('Deny with a note…'));
    const field = screen.getByRole('textbox');
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: 'Draft it first' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('r1', false, false, 'Draft it first');
  });

  it('gives focus back to Deny when the note is cancelled', async () => {
    render(
      <ApprovalCard message={approvalMessage} agentName="Acme" paused={false} onAnswer={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'More answers' }));
    fireEvent.click(await screen.findByText('Deny with a note…'));
    const field = screen.getByRole('textbox');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();
  });

  it('says its place in a run of similar requests', () => {
    render(
      <ApprovalCard
        message={approvalMessage}
        agentName="Acme"
        paused={false}
        onAnswer={vi.fn()}
        series={{ index: 2, total: 3 }}
      />
    );
    expect(screen.getByText('2 of 3 similar requests')).toBeInTheDocument();
  });
});

describe('NoteLine', () => {
  it('quotes a take-over terminal’s last lines quietly, as the screen showed them', () => {
    const message = {
      id: 'n2',
      agentId: 'acme',
      ts: 1,
      kind: 'note',
      takeover: true,
      text: 'Claude Code closed after 2 seconds. The last thing it showed:\n\nTrust it?\n❯ 2. No, exit',
    } as AgentMessage;
    const { container } = render(<NoteLine message={message} />);
    expect(container.querySelector('.agent-note--takeover')).not.toBeNull();
    expect(container.querySelector('.agent-bubble')).toBeNull();
    // The sentence is a Line; the screen is one click away, not a dump in the chat.
    expect(container.querySelector('pre')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show its last screen' }));
    expect(container.querySelector('pre')?.textContent).toBe('Trust it?\n❯ 2. No, exit');
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('A remembered rule', () => {
  const line = (active: boolean): AgentMessage => ({
    id: 'n3',
    agentId: 'lead',
    ts: 1,
    kind: 'note',
    text: 'Remembered: Lead Gen can always upsert social posts · Acme crm',
    remembered: { ruleId: 'rule-1', active },
  });

  it('offers Undo, which takes the rule back', async () => {
    const calls: Array<[string, unknown]> = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
    });
    render(<NoteLine message={line(true)} />);
    expect(screen.getByText(/Remembered: Lead Gen can always/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await Promise.resolve();
    });
    expect(calls).toContainEqual([
      'agents_revoke_permission',
      { agentId: 'lead', ruleId: 'rule-1' },
    ]);
    clearMocks();
  });

  it('says Undone once taken back, here or on the phone', () => {
    render(<NoteLine message={line(false)} />);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.getByText(/· Undone/)).toBeInTheDocument();
  });

  it('marks a card it allowed as by the user’s rule', () => {
    const message: AgentMessage = {
      ...approvalMessage,
      approval: {
        requestId: 'r2',
        title: 'Use a tool',
        detail: '',
        status: 'allowed',
        alwaysAllowed: true,
        always: {
          kind: 'tool',
          value: 'mcp__native-os__upsertSocialPosts',
          label: 'Upsert social posts · Acme crm',
          said: 'ur always allowed to do those',
        },
      },
    };
    render(
      <ApprovalCard message={message} agentName="Lead Gen" paused={false} onAnswer={vi.fn()} />
    );
    expect(screen.getByText(/Allowed by your rule/)).toBeInTheDocument();
  });
});

describe('ErrorLine', () => {
  it('quotes an older build’s take-over error as the screen showed it', () => {
    const message = {
      id: 'e2',
      agentId: 'acme',
      ts: 1,
      kind: 'error',
      takeover: true,
      text: 'Claude Code closed after 2 seconds. The last thing it showed:\n\nTrust it?\n❯ 2. No, exit',
    } as AgentMessage;
    const { container } = render(<ErrorLine message={message} />);
    expect(
      screen.getByText('Claude Code closed after 2 seconds. The last thing it showed:')
    ).toBeInTheDocument();
    expect(container.querySelector('pre')?.textContent).toBe('Trust it?\n❯ 2. No, exit');
  });

  it('schedules one retry at the reset however fast the second click comes', async () => {
    // Midday, so "in an hour" is today ("Retry at …"), whatever time the suite runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0));
    let finish = () => {};
    const onRetryAt = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const message: AgentMessage = {
      id: 'e1',
      agentId: 'acme',
      ts: Date.now(),
      kind: 'error',
      text: 'Out of usage',
      failure: { kind: 'usage_limit', resetsAt: Date.now() + 3_600_000 },
    };
    render(<ErrorLine message={message} onRetry={vi.fn()} onRetryAt={onRetryAt} />);
    const button = screen.getByRole('button', { name: /retry at/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRetryAt).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Scheduling…' })).toBeDisabled();
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: /retry at/i })).toBeEnabled();
  });

  it('keeps “Try now” beside the retry at the reset', () => {
    // Midday, so "in an hour" is today ("Retry at …"), whatever time the suite runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0));
    const onRetry = vi.fn();
    const message: AgentMessage = {
      id: 'e2',
      agentId: 'acme',
      ts: Date.now(),
      kind: 'error',
      text: 'Out of usage',
      failure: { kind: 'usage_limit', resetsAt: Date.now() + 3_600_000 },
    };
    render(<ErrorLine message={message} onRetry={onRetry} onRetryAt={vi.fn()} />);
    expect(screen.getByRole('button', { name: /retry at/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers another account at the limit, through the account row, only when that row is there', () => {
    const message: AgentMessage = {
      id: 'e3',
      agentId: 'acme',
      ts: Date.now(),
      kind: 'error',
      text: 'Usage limit reached',
      failure: { kind: 'usage_limit' },
    };
    // No account row on screen (no Agents sidebar): nothing to open, so no offer.
    const first = render(<ErrorLine message={message} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Add another account' })).not.toBeInTheDocument();
    first.unmount();

    const requests: string[] = [];
    const off = onSwitcherRequest((what) => requests.push(what));
    try {
      render(<ErrorLine message={message} onRetry={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Add another account' }));
      expect(requests).toEqual(['add']);
    } finally {
      off();
    }
  });

  it('never offers an account on a failure that isn’t the usage limit', () => {
    const off = onSwitcherRequest(() => {});
    try {
      render(
        <ErrorLine
          message={{
            id: 'e4',
            agentId: 'acme',
            ts: Date.now(),
            kind: 'error',
            text: 'Claude Code is signed out.',
            failure: { kind: 'signed_out' },
          }}
        />
      );
      expect(screen.queryByRole('button', { name: 'Add another account' })).not.toBeInTheDocument();
    } finally {
      off();
    }
  });

  // docs/design/failure-states.md: an engine that's gone offers Install,
  // not only Retry, which would fail the same way.
  it('offers Install when its engine isn’t on this Mac', () => {
    const onInstall = vi.fn();
    render(
      <ErrorLine
        engine="codex"
        onInstall={onInstall}
        onRetry={vi.fn()}
        message={{
          id: 'e5',
          agentId: 'acme',
          ts: Date.now(),
          kind: 'error',
          text: "Codex isn't on this Mac any more, or the app can't find it. Install it again, then send this again.",
          failure: { kind: 'engine_missing' },
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }));
    expect(onInstall).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('Start fresh', () => {
  const note = (fresh: boolean): AgentMessage => ({
    id: 'n1',
    agentId: 'acme',
    ts: Date.now(),
    kind: 'note',
    text: 'Started fresh · memory kept',
    fresh,
  });
  const agent = (over: Partial<Agent>): Agent =>
    ({
      id: 'acme',
      name: 'Acme',
      status: { state: 'idle', activity: null, since: null },
      ...over,
    }) as Agent;

  it('draws the fresh start as a divider, and other notes as notes', () => {
    const { rerender } = render(<NoteLine message={note(true)} />);
    expect(screen.getByRole('separator', { name: 'Started fresh · memory kept' })).toBeVisible();
    rerender(<NoteLine message={note(false)} />);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('suggests it only from a reported reading that is nearly full, and only while idle', () => {
    const onStartFresh = vi.fn();
    const full = { context: { used: 174_000, window: 200_000, at: 1 } };
    const { rerender, container } = render(
      <FreshHint agent={agent(full)} onStartFresh={onStartFresh} />
    );
    expect(container).toHaveTextContent(
      'This conversation is getting long — Acme may lose track of early details.'
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Start a new conversation (memory is kept)' })
    );
    expect(onStartFresh).toHaveBeenCalledTimes(1);

    // Nothing reported: nothing shown, never a guess.
    rerender(<FreshHint agent={agent({})} onStartFresh={onStartFresh} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <FreshHint
        agent={agent({ context: { used: 100_000, window: 200_000, at: 1 } })}
        onStartFresh={onStartFresh}
      />
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <FreshHint
        agent={agent({ ...full, status: { state: 'working', activity: null, since: 1 } })}
        onStartFresh={onStartFresh}
      />
    );
    expect(container).toBeEmptyDOMElement();
    // Driven by hand: Start fresh can't run, so it isn't offered.
    rerender(
      <FreshHint
        agent={agent({
          ...full,
          takeover: { ptySession: 'p', cli: 'claude', since: 1 } as unknown as Agent['takeover'],
        })}
        onStartFresh={onStartFresh}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
