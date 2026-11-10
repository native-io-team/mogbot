/**
 * Skills an agent saved after a hard task, on the desk: the "Save what it
 * learns" setting and its list in the editor, and the card in the chat
 * (Not now / Save, the neutral answer). Fictional agents only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({
  agentSkills: vi.fn(),
  editAgentSkill: vi.fn(),
  removeAgentSkill: vi.fn(),
}));
vi.mock('../../lib/agentSkills', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentSkills')>()),
  ...api,
}));
const updateAgent = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock('../../lib/agents', async (orig) => ({
  ...(await orig<typeof import('../../lib/agents')>()),
  updateAgent,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => undefined) }));
const store = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../lib/agentsStore', async (orig) => ({
  ...(await orig<typeof import('../../lib/agentsStore')>()),
  refreshAgents: () => Promise.resolve(),
  useAgentsSelector: (select: (s: unknown) => unknown) => select(store.value),
}));

import { AgentSkills } from './AgentSkills';
import { ApprovalCard } from './AgentChatItems';
import type { Agent, AgentMessage, Approval } from '../../lib/agents';

const ledger = { id: 'a1', name: 'Ledger', role: '', isMain: false } as Agent;
const skill = {
  slug: 'export-invoices',
  name: 'Export invoices',
  when: 'When asked for last month’s invoices',
  steps: '1. Open Reports\n2. Export as CSV',
};

describe('AgentSkills in the editor', () => {
  beforeEach(() => {
    store.value = { agents: [ledger] };
    api.agentSkills
      .mockReset()
      .mockResolvedValue({ agentId: 'a1', setting: 'ask', skills: [skill] });
    api.removeAgentSkill.mockReset().mockResolvedValue(undefined);
    api.editAgentSkill.mockReset().mockResolvedValue(skill);
    updateAgent.mockClear();
  });

  it('shows the setting (Ask me by default) and what it knows how to do', async () => {
    render(<AgentSkills agent={ledger} />);
    expect(await screen.findByText('Export invoices')).toBeTruthy();
    expect(screen.getByText('When asked for last month’s invoices')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask me' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(screen.getByText(/Anything that read outside content asks first/)).toBeTruthy();
  });

  it('changes the setting at once', async () => {
    render(<AgentSkills agent={ledger} />);
    await screen.findByText('Export invoices');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Automatically' }));
    });
    expect(updateAgent).toHaveBeenCalledWith('a1', { learnSkills: 'auto' });
  });

  it('removes and edits a skill', async () => {
    render(<AgentSkills agent={ledger} />);
    await screen.findByText('Export invoices');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    expect(api.removeAgentSkill).toHaveBeenCalledWith('a1', 'export-invoices');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'Export bills' } });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save skill' }));
    });
    expect(api.editAgentSkill).toHaveBeenCalledWith('a1', 'export-invoices', {
      name: 'Export bills',
      when: skill.when,
      steps: skill.steps,
    });
  });

  it('says what happens when it has none', async () => {
    api.agentSkills.mockResolvedValue({ agentId: 'a1', setting: 'off', skills: [] });
    store.value = { agents: [{ ...ledger, learnSkills: 'off' }] };
    render(<AgentSkills agent={ledger} />);
    expect(await screen.findByText('Ledger doesn’t save what it learns.')).toBeTruthy();
  });
});

describe('the skill card', () => {
  const card: Approval = {
    requestId: 'r1',
    title: 'Save “Export invoices” as a skill?',
    detail: skill.steps,
    summary: `When to use it: ${skill.when}`,
    status: 'pending',
    risk: 'low',
    skill: { ...skill, removed: 2 },
  };
  const message = (approval: Approval): AgentMessage => ({
    id: 'm1',
    agentId: 'a1',
    ts: Date.now(),
    kind: 'approval',
    text: '',
    approval,
  });

  it('previews the skill and answers Not now / Save, Save neutral', () => {
    const onAnswer = vi.fn();
    const { container } = render(
      <ApprovalCard message={message(card)} agentName="Ledger" paused={false} onAnswer={onAnswer} />
    );
    expect(screen.getByText(skill.when)).toBeTruthy();
    expect(screen.getByText(/1\. Open Reports/)).toBeTruthy();
    expect(screen.getByText('2 personal details or secrets removed.')).toBeTruthy();
    const save = screen.getByRole('button', { name: /^Save/ });
    expect(save.className).toMatch(/button--strong/);
    expect(save.className).not.toMatch(/button--primary/);
    expect(screen.getByRole('button', { name: /^Not now/ })).toBeTruthy();
    // Nothing broader to say instead: no "More answers" menu.
    expect(container.querySelector('[aria-label="More answers"]')).toBeNull();
  });

  it('reads as a receipt once answered', () => {
    render(
      <ApprovalCard
        message={message({ ...card, status: 'allowed' })}
        agentName="Ledger"
        paused={false}
        onAnswer={vi.fn()}
      />
    );
    expect(screen.getByText('Saved · under What it knows how to do')).toBeTruthy();
  });
});
