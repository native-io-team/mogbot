import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentMessage, Approval } from '../../lib/agents';
import { WaitingForYouBar, waitingOn } from './WaitingForYouBar';

const msg = (approval: Partial<Approval>): AgentMessage =>
  ({
    id: approval.requestId ?? 'm',
    agentId: 'a1',
    kind: 'approval',
    text: '',
    ts: 1,
    approval: {
      requestId: 'r',
      title: 'Run a command',
      detail: 'x',
      status: 'pending',
      ...approval,
    },
  }) as AgentMessage;

const waiting = { status: { state: 'waiting' as const }, name: 'Researcher' };
const idle = { status: { state: 'idle' as const }, name: 'Researcher' };

describe('waitingOn', () => {
  it('names the newest open card the turn is stopped on', () => {
    const log = [
      msg({ requestId: 'old', title: 'Old', status: 'expired' }),
      msg({ requestId: 'r1', title: 'Run a command' }),
      msg({ requestId: 'login', title: 'Needs your Gmail', login: {} as Approval['login'] }),
    ];
    expect(waitingOn(waiting as never, log)?.requestId).toBe('r1');
  });

  it('is nothing when the agent is not waiting, or only a sign-in is open', () => {
    expect(waitingOn(idle as never, [msg({})])).toBeNull();
    expect(waitingOn(waiting as never, [msg({ secret: {} as Approval['secret'] })])).toBeNull();
  });
});

describe('WaitingForYouBar', () => {
  it('says who is waiting on you, calmly, and nothing more', () => {
    render(
      <WaitingForYouBar agent={waiting as never} messages={[msg({ title: 'Push to GitHub' })]} />
    );
    const bar = screen.getByTestId('agent-waiting-bar');
    expect(bar.textContent).toBe('Researcher is waiting on youReview');
    expect(bar.textContent).not.toMatch(/stopped|until you answer/i);
  });

  it("never repeats the card's question (docs/agents.md, a bar says the state)", () => {
    render(
      <WaitingForYouBar agent={waiting as never} messages={[msg({ title: 'Push to GitHub' })]} />
    );
    expect(screen.getByTestId('agent-waiting-bar').textContent).not.toContain('Push to GitHub');
  });

  it('never points "below" or at "the card" and offers Review, which brings it into view', () => {
    render(
      <WaitingForYouBar agent={waiting as never} messages={[msg({ title: 'Push to GitHub' })]} />
    );
    const bar = screen.getByTestId('agent-waiting-bar');
    expect(bar.textContent).not.toMatch(/below|above|the card/);
    const scrolled: Element[] = [];
    const card = document.createElement('div');
    card.dataset.messageIds = 'm';
    card.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    document.body.appendChild(card);
    screen.getByRole('button', { name: 'Review' }).click();
    expect(scrolled).toEqual([card]);
    card.remove();
  });

  it('shows nothing while the agent works', () => {
    const { container } = render(<WaitingForYouBar agent={idle as never} messages={[msg({})]} />);
    expect(container.textContent).toBe('');
  });
});
