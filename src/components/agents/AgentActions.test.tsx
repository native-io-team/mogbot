import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dropdown } from '../primitives/Dropdown';
import { AgentActionItems, type AgentActions } from './AgentActions';
import type { Agent } from '../../lib/agents';

const agent = {
  id: 'finance',
  name: 'Finance',
  color: 'orange',
  engine: 'claude',
  isMain: false,
  pinned: false,
  hidden: false,
  muted: false,
  unread: 0,
  status: { state: 'idle' },
} as unknown as Agent;

const actions: AgentActions = {
  onTogglePin: vi.fn(),
  onToggleHidden: vi.fn(),
  onToggleMuted: vi.fn(),
  onMarkUnread: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onStartFresh: vi.fn(),
  onTakeOver: vi.fn(),
  onOnItsOwn: vi.fn(),
};

describe('the agent … menu', () => {
  it('holds actions only, at most ten, with Delete last after a divider', () => {
    render(
      <Dropdown open trigger={(p) => <button {...p}>…</button>}>
        <AgentActionItems
          agent={agent}
          kind="dropdown"
          onSchedule={vi.fn()}
          onFiles={vi.fn()}
          {...actions}
        />
      </Dropdown>
    );
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
    expect(items.length).toBeLessThanOrEqual(12);
    expect(items[0]).toBe('Edit agent…');
    expect(items[items.length - 1]).toBe('Delete…');
    // No settings among the actions: model and effort live in the Model menu.
    expect(items.some((t) => /Model|Effort|Engine’s default/.test(t))).toBe(false);
    const menu = screen.getByRole('menu');
    const last = menu.lastElementChild;
    expect(last?.previousElementSibling?.className).toContain('ss-dropdown__divider');
  });
});
