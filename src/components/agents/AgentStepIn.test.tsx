import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StepInBar, StepInCard } from './AgentStepIn';
import type { Agent, AgentMessage, Approval } from '../../lib/agents';
import { activeStepIn, stepInBarDetail, stepInOutcome } from '../../lib/agentStepIn';
import { ARM_MS } from './useCardGuard';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke,
}));

const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

const agent = { id: 'res', name: 'Research' } as Agent;

function card(extra: Partial<Approval> = {}, live?: { inSince: number; until: number }) {
  return {
    id: 'm1',
    agentId: 'res',
    ts: 1,
    kind: 'approval',
    text: '',
    approval: {
      requestId: 'req-1',
      title: 'Research needs you in its browser: approve the Okta sign-in',
      detail: 'Its tab on idp.example opens on this Mac.',
      status: 'pending',
      stepIn: {
        reason: 'approve the Okta sign-in',
        site: 'idp.example',
        url: 'https://idp.example/sso',
        pageTitle: 'Sign in',
        tab: 2,
        ...live,
      },
      ...extra,
    },
  } as AgentMessage;
}

const arm = () => act(() => new Promise((r) => setTimeout(r, ARM_MS + 50)));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe('Step in card', () => {
  it('asks with Not now and Step in, and Step in goes to the Mac’s own command', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<StepInCard message={card()} onAnswer={onAnswer} />);
    expect(
      screen.getByText(/needs you in its browser: approve the Okta sign-in/)
    ).toBeInTheDocument();
    expect(screen.getByText('idp.example · Sign in')).toBeInTheDocument();
    expect(screen.getByText(/never sees what you type/)).toBeInTheDocument();
    const step = screen.getByRole('button', { name: 'Step in' });
    // Neutral, never the accent (an agent's colour can be red).
    expect(step.className).not.toMatch(/primary/);
    await arm();
    await act(async () => {
      fireEvent.click(step, { detail: 1 });
      await Promise.resolve();
    });
    expect(calls('agents_step_in')).toEqual([
      ['agents_step_in', { agentId: 'res', requestId: 'req-1' }],
    ]);
    // Never a plain Allow: Step in isn't an approval answer.
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('Not now declines through the card answer', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<StepInCard message={card()} onAnswer={onAnswer} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      await Promise.resolve();
    });
    expect(onAnswer).toHaveBeenCalledWith('req-1', false);
  });

  it('while you’re in it: Show window and Hand back', async () => {
    render(
      <StepInCard
        message={card({}, { inSince: 1_000, until: 1_000 + 15 * 60_000 })}
        onAnswer={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Step in' })).toBeNull();
    expect(screen.getByText(/You’re in its browser now/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
      await Promise.resolve();
    });
    expect(calls('agents_step_in_hand_back')).toEqual([
      ['agents_step_in_hand_back', { agentId: 'res', requestId: 'req-1' }],
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show window' }));
      await Promise.resolve();
    });
    expect(calls('agents_step_in_show')).toHaveLength(1);
  });

  it('in its own chat, leaves Show window and Hand back to the bar', () => {
    render(
      <StepInCard
        message={card({}, { inSince: 1_000, until: 1_000 + 15 * 60_000 })}
        onAnswer={vi.fn()}
        barShown
      />
    );
    expect(screen.getByText(/Hand back from the bar below/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hand back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
  });

  it('closes to one line', () => {
    render(<StepInCard message={card({ status: 'allowed' })} onAnswer={vi.fn()} />);
    expect(screen.getByText('Handed back')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Step in' })).toBeNull();
    const timed = card({ status: 'expired', setAside: 'Handed back by itself after 15 min' });
    expect(stepInOutcome(timed.approval!)).toBe('Handed back by itself after 15 min');
    expect(stepInOutcome(card({ status: 'denied' }).approval!)).toBe('Not now');
  });
});

describe('Step in bar', () => {
  it('shows only while you’re in its browser, and hands back', async () => {
    const { rerender } = render(<StepInBar agent={agent} messages={[card()]} />);
    expect(screen.queryByTestId('agent-step-in-bar')).toBeNull();
    const now = 1_000 + 4 * 60_000;
    rerender(
      <StepInBar
        agent={agent}
        now={now}
        messages={[card({}, { inSince: 1_000, until: 1_000 + 15 * 60_000 })]}
      />
    );
    const bar = screen.getByTestId('agent-step-in-bar');
    expect(bar).toHaveTextContent('You’re in Research’s browser');
    expect(bar).toHaveTextContent('idp.example · hands back by itself in 11 min');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hand back' }));
      await Promise.resolve();
    });
    expect(calls('agents_step_in_hand_back')).toHaveLength(1);
  });

  it('names the phone that stepped in, with Hand back and no Show window', async () => {
    const live = { inSince: 1_000, until: 1_000 + 15 * 60_000 };
    const fromPhone = card({}, live);
    fromPhone.approval!.stepIn!.onPhone = 'Sam’s iPhone';
    render(<StepInBar agent={agent} now={2_000} messages={[fromPhone]} />);
    const bar = screen.getByTestId('agent-step-in-bar');
    expect(bar).toHaveTextContent('Sam’s iPhone is in Research’s browser');
    expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
    render(<StepInCard message={fromPhone} onAnswer={vi.fn()} />);
    expect(screen.getByText(/Sam’s iPhone is in its browser now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show window' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Hand back' })[1]);
      await Promise.resolve();
    });
    expect(calls('agents_step_in_hand_back')).toHaveLength(1);
  });

  it('finds the step-in under way, never an answered one', () => {
    const live = card({}, { inSince: 1, until: 2 });
    expect(activeStepIn([card(), live])?.requestId).toBe('req-1');
    expect(activeStepIn([card({ status: 'allowed' }, { inSince: 1, until: 2 })])).toBeNull();
    expect(activeStepIn([card()])).toBeNull();
    expect(stepInBarDetail(live.approval!.stepIn!, 1)).toBe(
      'idp.example · hands back by itself in a minute'
    );
  });
});
