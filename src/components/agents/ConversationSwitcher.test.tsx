/**
 * The chat header's conversation switcher: the one on screen marked with the
 * selected row (a check, not accent-coloured words), a plain "Recent" over
 * the list, tidied automatic titles, Enter on a search opening the first
 * match, and Escape giving focus back to the button.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Agent } from '../../lib/agents';
import type { Conversations, ConversationView } from '../../lib/agentConversations';

const item = (id: string, title: string, extra: Partial<ConversationView> = {}) => ({
  id,
  title,
  named: false,
  createdAt: 0,
  lastActivityAt: 0,
  current: false,
  loaded: false,
  waiting: 0,
  ...extra,
});

const LIST: Conversations = {
  agentId: 'a1',
  current: 'c1',
  items: [
    // As an older Mac sent it: the whole first line, clipped with "…".
    item('c1', 'I Kind of like B with a hint of A. L…', { current: true, loaded: true }),
    item('c2', 'Chase the two overdue invoices'),
    item('first', 'can you keep MY name', { named: true }),
  ],
  routines: {},
};

const openConversation = vi.hoisted(() => vi.fn((_a: string, _c: string) => Promise.resolve()));
vi.mock('../../lib/agentsStore', () => ({
  openConversation,
  refreshConversations: vi.fn(() => Promise.resolve(null)),
  renameConversation: vi.fn(() => Promise.resolve()),
  startConversation: vi.fn(() => Promise.resolve()),
  useAgentsSelector: (select: (s: unknown) => unknown) => select({ conversations: { a1: LIST } }),
}));
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast: vi.fn() }),
}));

import { ConversationSwitcher } from './ConversationSwitcher';

const agent = { id: 'a1', name: 'Acme', status: { state: 'idle' } } as unknown as Agent;

function open() {
  render(<ConversationSwitcher agent={agent} viewing="c1" />);
  const trigger = screen.getByRole('button', { name: /Switch conversation/ });
  fireEvent.click(trigger);
  return trigger;
}

describe('ConversationSwitcher', () => {
  beforeEach(() => openConversation.mockClear());

  it('names the one on screen with its tidied title on the button', () => {
    render(<ConversationSwitcher agent={agent} viewing="c1" />);
    expect(
      screen.getByRole('button', {
        name: 'Conversation: I kind of like B with a hint of A. Switch conversation',
      })
    ).toBeInTheDocument();
  });

  it('marks the one on screen as the selected row with a check, under a plain “Recent”', () => {
    open();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.queryByText(/memory is shared/)).toBeNull();
    const current = screen.getByRole('menuitem', { name: /I kind of like B/ });
    expect(current).toHaveClass('ss-dropdown__item--active');
    expect(current.querySelector('[aria-label="On screen"]')).not.toBeNull();
    // A typed name is shown as typed.
    expect(screen.getByRole('menuitem', { name: /can you keep MY name/ })).toBeInTheDocument();
  });

  it('draws the selected row’s words in the text colour, never the accent', () => {
    const css = readFileSync(resolve('src/styles/features/agents-menus.css'), 'utf8');
    const rule = css.match(/\.agent-conversations__menu \.ss-dropdown__item--active\s*\{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/color:\s*var\(--text-primary\)/);
    expect(rule?.[1]).not.toMatch(/accent/);
  });

  it('Enter in the search opens the first match and closes the menu', async () => {
    open();
    const field = screen.getByRole('textbox', { name: 'Find a conversation' });
    fireEvent.change(field, { target: { value: 'invoice' } });
    expect(screen.queryByText('Recent')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(openConversation).toHaveBeenCalledWith('a1', 'c2');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Enter with nothing typed does nothing; Escape closes and focuses the button', () => {
    const trigger = open();
    const field = screen.getByRole('textbox', { name: 'Find a conversation' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(openConversation).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('ArrowDown from the search moves into the list', () => {
    open();
    const field = screen.getByRole('textbox', { name: 'Find a conversation' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /New conversation/ })).toHaveFocus();
  });
});
