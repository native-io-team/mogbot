import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentUsageSettings, AgentsSpareNote } from './AgentsUsage';
import type { UsageInventory } from '../../lib/agentsUsage';
import {
  EMPTY_INVENTORY,
  FULL_INVENTORY,
  ONE_READ_INVENTORY,
  RUNOUT_INVENTORY,
  TWO_CLAUDE_INVENTORY,
} from '../../harness/scenarios/agentsUsage';

afterEach(() => {
  cleanup();
  clearMocks();
});

function serve(inventory: unknown, calls: { cmd: string; args: unknown }[] = []) {
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'agents_usage_overview') return inventory as UsageInventory;
      return null;
    },
    { shouldMockEvents: true }
  );
  return calls;
}

describe('Settings → Agents → Usage', () => {
  it('shows readings as reported, labels estimates, and lists other compute', async () => {
    serve(FULL_INVENTORY);
    render(<AgentUsageSettings />);
    expect(
      await screen.findByText('How agents use your limits', { selector: 'span' })
    ).toBeInTheDocument();
    // Every account at once, from readings only.
    expect(
      screen.getByText(
        /^Room now on Claude · This Mac and Codex · ChatGPT Plus\. Claude · Work has room again /
      )
    ).toBeInTheDocument();
    expect(screen.getByText('4 accounts · Claude 3, Codex 1 · 1 not read')).toBeInTheDocument();
    expect(screen.getByText(/^2 of 2 have room · soonest reset /)).toBeInTheDocument();
    expect(screen.getByText(/^1 of 2 has room · soonest reset /)).toBeInTheDocument();
    // Each account once, most room first, its bars side by side.
    const rows = screen.getAllByRole('listitem').filter((li) => li.matches('.agents-compute__row'));
    expect(rows.map((r) => r.querySelector('.agents-compute__name')?.textContent)).toEqual([
      'Claude · This Mac',
      'Codex · ChatGPT Plus',
      'Claude · Personal',
      'Claude · Work',
    ]);
    expect(rows[0].querySelectorAll('[role="meter"]')).toHaveLength(2);
    expect(rows[0].textContent).toContain('Used next');
    expect(rows[0].textContent).not.toContain('Next turn');
    expect(rows[0].textContent).toMatch(/Weekly: At this pace you’ll hit the limit/);
    // The bar the pace line is about agrees with it.
    const tones = [...rows[0].querySelectorAll('.agents-compute__meter')].map((m) =>
      m.getAttribute('data-tone')
    );
    expect(tones).toEqual(['calm', 'warning']);
    expect(rows[1].textContent).toContain('Plus plan');
    expect(rows[2].textContent).toContain('Can’t read its limits between turns');
    expect(rows[2].textContent).not.toMatch(/runs to measure/);
    expect(rows[3].textContent).toMatch(/Out of usage until /);
    expect(rows[3].querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(
      screen.getByText('Claude Code: About 48k tokens a turn · estimate from 212 past runs')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ollama · running · llama3.2:3b, qwen2.5-coder:7b')
    ).toBeInTheDocument();
    expect(screen.getByText(/^Claude 5-hour limit resets .* · 62% unused$/)).toBeInTheDocument();
    // The list, with who added each.
    expect(screen.getByText('Added by you · for Research')).toBeInTheDocument();
    expect(screen.getByText('Added by Finance · Started')).toBeInTheDocument();
  });

  it('with no reading and no history, invents nothing', async () => {
    serve(EMPTY_INVENTORY);
    const { container } = render(<AgentUsageSettings />);
    expect(await screen.findByText('Not checked yet')).toBeInTheDocument();
    expect(screen.getByText('No limits read yet.')).toBeInTheDocument();
    expect(container.querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/estimate|tokens a turn|unused/);
    expect(container.textContent).not.toContain('Codex');
    expect(container.textContent).not.toContain('Other compute');
  });

  it('changing the mode and adding to the list go to the Mac', async () => {
    const calls = serve(EMPTY_INVENTORY);
    render(<AgentUsageSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save my limits' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ cmd: 'agents_set_usage_mode', args: { mode: 'save' } })
    );
    fireEvent.change(screen.getByLabelText('Add to the spare-capacity list'), {
      target: { value: '  Read the backlog  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        cmd: 'agents_spare_add',
        args: { text: 'Read the backlog', agentId: null },
      })
    );
  });
});

describe('Settings → Agents → Usage: two Claude accounts, Codex signed out', () => {
  it('names the account with room, and never counts signed out as not read', async () => {
    serve(TWO_CLAUDE_INVENTORY);
    const { container } = render(<AgentUsageSettings />);
    expect(
      await screen.findByText(/^Room now on Claude · This Mac\. Claude · Personal has room again /)
    ).toBeInTheDocument();
    expect(screen.getByText('3 accounts · Claude 2, Codex 1')).toBeInTheDocument();
    // Only the weekly limit was read on two accounts.
    expect(container.querySelectorAll('.agents-compute__window')).toHaveLength(1);
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
  });

  it('with one account read, says its estimate once, up top, and drops the aggregates', async () => {
    serve(ONE_READ_INVENTORY);
    const { container } = render(<AgentUsageSettings />);
    const headline = await screen.findByText(/^Room now on Claude · This Mac\./);
    expect(headline.textContent).toMatch(
      /At this pace the weekly limit runs out .+, before it resets /
    );
    expect(screen.getByText('Estimate from 200 readings over 10 hours')).toBeInTheDocument();
    expect(container.querySelectorAll('.agents-compute__window')).toHaveLength(0);
    const rows = [...container.querySelectorAll('.agents-compute__row')];
    expect(rows[0].textContent).not.toMatch(/At this pace|Used next/);
    expect(rows[0].querySelectorAll('.agents-compute__meter')[1].getAttribute('data-tone')).toBe(
      'warning'
    );
    expect(rows[1].textContent).toContain('with the token it was added with');
  });
});

describe('Settings → Agents → Usage: running out everywhere', () => {
  it('says the estimate across accounts with what it rests on', async () => {
    serve(RUNOUT_INVENTORY);
    render(<AgentUsageSettings />);
    expect(await screen.findByText(/^Room now on all 3 accounts\./)).toBeInTheDocument();
    expect(
      screen.getByText(
        /At this pace you’ll run out of Claude on every account in about 3 hours; Codex has room\./
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Estimate from 13 readings across 2 accounts')).toBeInTheDocument();
  });

  it('falls back to each engine’s list from a Mac that serves no totals', async () => {
    const { totals: _none, ...older } = FULL_INVENTORY;
    serve(older);
    render(<AgentUsageSettings />);
    expect(await screen.findByText(/^5-hour 38% · resets .* · Weekly 61%/)).toBeInTheDocument();
    expect(document.querySelector('.agents-compute')).toBeNull();
  });
});

describe('What’s in flight: spare capacity', () => {
  it('says nothing without a spare window on the account turns run on', async () => {
    serve(EMPTY_INVENTORY);
    const { container } = render(<AgentsSpareNote />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('one quiet line when a reset is near with capacity left', async () => {
    serve(FULL_INVENTORY);
    render(<AgentsSpareNote />);
    const line = await screen.findByText(/^Claude 5-hour limit resets .* · 62% unused$/);
    expect(line.getAttribute('title')).toContain('spare-capacity list (1 waiting)');
  });
});
