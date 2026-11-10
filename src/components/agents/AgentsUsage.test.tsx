import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AgentsSpareNote, SpareList } from './AgentsUsage';
import type { UsageInventory } from '../../lib/agentsUsage';
import { EMPTY_INVENTORY, FULL_INVENTORY } from '../../harness/scenarios/agentsUsage';

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

describe('the list of ideas for leftover usage', () => {
  it('lists who added each, and adding goes to the Mac', async () => {
    const calls = serve(FULL_INVENTORY);
    render(<SpareList inventory={FULL_INVENTORY as UsageInventory} onChanged={() => {}} />);
    expect(screen.getByText('Added by you · for Research')).toBeInTheDocument();
    expect(screen.getByText('Added by Finance · Started')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Add to your ideas for leftover usage'), {
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

describe('What’s in flight: spare capacity', () => {
  it('says nothing without a spare window on the account turns run on', async () => {
    serve(EMPTY_INVENTORY);
    const { container } = render(<AgentsSpareNote />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('one quiet line when a reset is near with capacity left, said as what is left', async () => {
    serve(FULL_INVENTORY);
    render(<AgentsSpareNote />);
    const line = await screen.findByText(/^Claude 5-hour limit refills .* · 62% left$/);
    expect(line.getAttribute('title')).toContain('ideas for leftover usage (1 waiting)');
    // "This Mac" is where it's signed in, never named as the account.
    expect(line.getAttribute('title')).not.toMatch(/On This Mac/);
  });
});
