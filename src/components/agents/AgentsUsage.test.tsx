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
    // Every account at once, from readings only: one short headline, no counts.
    expect(screen.getByText('Room now on 2 of 3 accounts')).toBeInTheDocument();
    expect(document.querySelector('.agents-compute')?.textContent).not.toMatch(
      /not read|have room ·|has room again/
    );
    // Each account with a reading a card, most room first, a row per limit.
    const rows = [...document.querySelectorAll('.agents-compute__row')];
    expect(rows.map((r) => r.querySelector('.agents-compute__name')?.textContent)).toEqual([
      'Claude · This Mac',
      'Codex · ChatGPT Plus',
    ]);
    expect(rows[0].querySelectorAll('[role="meter"]')).toHaveLength(2);
    expect(rows[0].textContent).toContain('Used next');
    expect(rows[0].textContent).not.toContain('Next turn');
    // The pace line sits under the bar it is about, which agrees with it.
    const meters = [...rows[0].querySelectorAll('.agents-compute__meter')];
    expect(meters.map((m) => m.getAttribute('data-tone'))).toEqual(['calm', 'warning']);
    expect(meters[0].textContent).not.toMatch(/At this pace/);
    expect(meters[1].textContent).toMatch(/At this pace it runs out .+Estimate from 14 readings/);
    expect(rows[1].textContent).toContain('Plus plan');
    // No bar to draw: compact and quiet, each with its line.
    const quiet = [...document.querySelectorAll('.agents-compute__quiet-row')];
    expect(quiet.map((r) => r.querySelector('.agents-compute__quiet-name')?.textContent)).toEqual([
      'Claude · Personal',
      'Claude · Work',
    ]);
    expect(quiet[0].textContent).toContain('Can’t read its limits between turns');
    expect(quiet[0].textContent).not.toMatch(/runs to measure/);
    expect(quiet[1].textContent).toMatch(/Out of usage until /);
    expect(quiet[1].querySelectorAll('[role="meter"]')).toHaveLength(0);
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
    expect(screen.getByText('No limits read yet')).toBeInTheDocument();
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
    expect(await screen.findByText('Room now on Claude · This Mac')).toBeInTheDocument();
    // The out account's own line says when; the headline doesn't repeat it.
    expect(container.textContent).not.toMatch(/has room again|3 accounts/);
    expect(screen.getByText(/^Out of usage until /)).toBeInTheDocument();
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
  });

  it('with one account read, says its estimate once, under its weekly bar', async () => {
    serve(ONE_READ_INVENTORY);
    const { container } = render(<AgentUsageSettings />);
    const headline = await screen.findByText('Room now on Claude · This Mac');
    expect(headline.textContent).not.toMatch(/At this pace/);
    expect(screen.getAllByText(/^At this pace/)).toHaveLength(1);
    expect(screen.getByText('Estimate from 200 readings over 10 hours')).toBeInTheDocument();
    const rows = [...container.querySelectorAll('.agents-compute__row')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).not.toMatch(/Used next/);
    const weekly = rows[0].querySelectorAll('.agents-compute__meter')[1];
    expect(weekly.getAttribute('data-tone')).toBe('warning');
    expect(weekly.textContent).toMatch(/At this pace it runs out /);
    expect(container.querySelector('.agents-compute__quiet')?.textContent).toContain(
      'with the token it was added with'
    );
  });
});

describe('Settings → Agents → Usage: running out everywhere', () => {
  it('says the estimate across accounts with what it rests on', async () => {
    serve(RUNOUT_INVENTORY);
    render(<AgentUsageSettings />);
    expect(await screen.findByText('Room now on all 3 accounts')).toBeInTheDocument();
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
