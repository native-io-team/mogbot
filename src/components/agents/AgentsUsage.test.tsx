import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentUsageSettings, AgentsSpareNote } from './AgentsUsage';
import type { UsageInventory } from '../../lib/agentsUsage';
import {
  EMPTY_INVENTORY,
  FULL_INVENTORY,
  RUNOUT_INVENTORY,
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
      screen.getByText(/^You have room on 2 accounts right now\. Claude · Work resets /)
    ).toBeInTheDocument();
    expect(screen.getByText('4 accounts · Claude 3, Codex 1 · 1 not read yet')).toBeInTheDocument();
    expect(screen.getByText('2 of 2 have room')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 has room')).toBeInTheDocument();
    // Each account once, most room first, its bars side by side.
    const rows = screen.getAllByRole('listitem').filter((li) => li.matches('.agents-compute__row'));
    expect(rows.map((r) => r.querySelector('.agents-compute__name')?.textContent)).toEqual([
      'Claude · This Mac',
      'Codex · ChatGPT Plus',
      'Claude · Personal',
      'Claude · Work',
    ]);
    expect(rows[0].querySelectorAll('[role="meter"]')).toHaveLength(2);
    expect(rows[0].textContent).toContain('Next turn');
    expect(rows[0].textContent).toMatch(/Weekly: At this pace you’ll hit the limit/);
    expect(rows[1].textContent).toContain('Plus plan');
    expect(rows[2].textContent).toContain('No reading yet · runs to measure');
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
    expect(await screen.findByText('No reading yet')).toBeInTheDocument();
    expect(screen.getByText('No reading yet.')).toBeInTheDocument();
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

describe('Settings → Agents → Usage: running out everywhere', () => {
  it('says the estimate across accounts with what it rests on', async () => {
    serve(RUNOUT_INVENTORY);
    render(<AgentUsageSettings />);
    expect(
      await screen.findByText('You have room on all 3 accounts right now.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'At this pace you’ll run out of Claude on every account in about 3 hours; Codex has room.'
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
