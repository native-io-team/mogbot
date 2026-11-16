/**
 * The living page under the chat header: drawn from the Mac's page, its
 * versions one press away, an older one opened read-only, folding
 * remembered, Unpin, and the header's Pin page once it's unpinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agent } from '../../lib/agents';

const PAGE = {
  agentId: 'a1',
  conversation: 'first',
  pinned: true,
  version: 2,
  at: Date.now() - 3 * 60_000,
  title: 'Job search',
  note: 'Acme moved on',
  changes: { added: [], changed: ['apps'], removed: [] },
  byRoutine: true,
  blocks: {
    v: 1,
    items: [
      {
        id: 'apps',
        kind: 'checklist',
        title: 'Applications',
        summary: '',
        items: [{ text: 'Acme', done: true }],
      },
    ],
  },
  history: [
    {
      version: 2,
      at: Date.now() - 3 * 60_000,
      title: 'Job search',
      note: 'Acme moved on',
      changes: { added: [], changed: ['apps'], removed: [] },
      byRoutine: true,
    },
    {
      version: 1,
      at: Date.now() - 86_400_000,
      title: 'Job search',
      changes: { added: ['apps'], changed: [], removed: [] },
    },
  ],
};
const V1 = {
  version: 1,
  at: PAGE.history[1].at,
  title: 'Job search',
  changes: PAGE.history[1].changes,
  blocks: {
    v: 1,
    items: [
      {
        id: 'apps',
        kind: 'checklist',
        title: 'Applications',
        summary: '',
        items: [{ text: 'Acme', done: false }],
      },
    ],
  },
};

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
type Cmd = { id: string; title: string; when?: () => boolean; run: () => void };
const registered = vi.hoisted(() => ({ byId: {} as Record<string, Cmd> }));
vi.mock('../../commands/useCommands', () => ({
  useCommands: (make: () => Cmd[]) => {
    for (const c of make()) registered.byId[c.id] = c;
  },
}));
const command = (id: string) => registered.byId[id];
vi.mock('../../contexts/ToastContext', () => ({
  useOptionalToast: () => ({ showToast: vi.fn() }),
}));

import {
  ConversationPage,
  ConversationPagePin,
  PAGE_CHAT_ROOM,
  PAGE_MIN_HEIGHT,
  SHORT_WINDOW,
} from './ConversationPage';
import { resetPageCache } from '../../lib/agentPage';

const agent = {
  id: 'a1',
  name: 'Scout',
  color: 'blue',
  status: { state: 'idle' },
} as unknown as Agent;

// jsdom has no PointerEvent: the divider's drag needs its pointerId and clientY.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

let pinned = true;
beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  pinned = true;
  window.localStorage.clear();
  resetPageCache();
  invoke.mockImplementation((cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'agents_page') return Promise.resolve({ ...PAGE, pinned });
    if (cmd === 'agents_page_version') return Promise.resolve(args.version === 1 ? V1 : null);
    if (cmd === 'agents_page_pin') {
      pinned = Boolean(args.pinned);
      return Promise.resolve({ ...PAGE, pinned });
    }
    return Promise.reject(new Error(`unmocked ${cmd}`));
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const both = () =>
  render(
    <>
      <ConversationPagePin agent={agent} conversation="first" />
      <ConversationPage agent={agent} conversation="first" />
    </>
  );

describe('ConversationPage', () => {
  it('draws the page with when it changed, and its versions on a press', async () => {
    both();
    await screen.findByRole('region', { name: 'Page: Job search' });
    expect(screen.getByText('Applications')).toBeTruthy();
    const when = screen.getByRole('button', { name: 'Updated 3 min ago by a routine' });
    fireEvent.click(when);
    const versions = screen.getByRole('list', { name: 'Versions' });
    expect(versions.textContent).toContain('Version 2 · 3 min ago · by a routine');
    expect(versions.textContent).toContain('Changed Applications — Acme moved on');
    expect(versions.textContent).toContain('Made the page');
    // An older version, read-only, then back.
    fireEvent.click(screen.getByText(/^Version 1 ·/));
    await screen.findByText(/Version 1, as it was/);
    expect(invoke).toHaveBeenCalledWith('agents_page_version', {
      agentId: 'a1',
      conversation: 'first',
      version: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to the latest' }));
    expect(screen.queryByText(/Version 1, as it was/)).toBeNull();
    // Nothing on a page answers: no buttons inside the blocks.
    expect(screen.queryByRole('button', { name: /Pick this/ })).toBeNull();
  });

  it('folds, and remembers it per conversation', async () => {
    const { unmount } = both();
    const toggle = await screen.findByRole('button', { name: /Job search/, expanded: true });
    fireEvent.click(toggle);
    expect(screen.queryByText('Applications')).toBeNull();
    unmount();
    both();
    await screen.findByRole('button', { name: /Job search/, expanded: false });
  });

  it('drags taller with the divider, remembers it, and a double-click puts it back', async () => {
    const { unmount } = both();
    const divider = await screen.findByRole('separator', { name: 'Resize the page' });
    const body = () => document.querySelector<HTMLElement>('.agent-page__body')!;
    act(() => {
      fireEvent.pointerDown(divider, { pointerId: 1, clientY: 200 });
      fireEvent.pointerMove(divider, { pointerId: 1, clientY: 300 });
      fireEvent.pointerUp(divider, { pointerId: 1, clientY: 300 });
    });
    expect(body().style.height).toBe('300px');
    unmount();
    both();
    await screen.findByRole('separator', { name: 'Resize the page' });
    expect(body().style.height).toBe('300px');
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize the page' }));
    expect(body().style.height).toBe('');
    expect(body().hasAttribute('data-sized')).toBe(false);
  });

  it('keeps the chat its room and the page its minimum, by drag or arrow keys', async () => {
    both();
    const divider = await screen.findByRole('separator', { name: 'Resize the page' });
    const body = () => document.querySelector<HTMLElement>('.agent-page__body')!;
    const tallest = window.innerHeight - PAGE_CHAT_ROOM;
    act(() => {
      fireEvent.pointerDown(divider, { pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(divider, { pointerId: 1, clientY: window.innerHeight });
      fireEvent.pointerUp(divider, { pointerId: 1, clientY: window.innerHeight });
    });
    expect(body().style.height).toBe(`${tallest}px`);
    fireEvent.keyDown(divider, { key: 'ArrowUp' });
    expect(body().style.height).toBe(`${tallest - 10}px`);
    act(() => {
      fireEvent.pointerDown(divider, { pointerId: 2, clientY: 100 });
      fireEvent.pointerMove(divider, { pointerId: 2, clientY: 5 });
      fireEvent.pointerUp(divider, { pointerId: 2, clientY: 5 });
    });
    expect(body().style.height).toBe(`${PAGE_MIN_HEIGHT}px`);
  });

  it('has no divider while folded', async () => {
    both();
    fireEvent.click(await screen.findByRole('button', { name: /Job search/, expanded: true }));
    expect(screen.queryByRole('separator', { name: 'Resize the page' })).toBeNull();
  });

  it('starts folded in a short window until the user opens it, then remembers that', async () => {
    const mm = vi.fn((q: string) => ({ matches: q === SHORT_WINDOW }) as MediaQueryList);
    vi.stubGlobal('matchMedia', mm);
    try {
      const { unmount } = both();
      const toggle = await screen.findByRole('button', { name: /Job search/, expanded: false });
      expect(screen.queryByText('Applications')).toBeNull();
      fireEvent.click(toggle);
      expect(screen.getByText('Applications')).toBeTruthy();
      unmount();
      both();
      await screen.findByRole('button', { name: /Job search/, expanded: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('⌘K folds the page and opens what changed, by name', async () => {
    both();
    await screen.findByRole('region', { name: 'Page: Job search' });
    expect(command('agents.pageFold')?.title).toBe('Fold the page “Job search”');
    expect(command('agents.pageVersions')?.title).toBe('What changed on this page');
    act(() => command('agents.pageVersions').run());
    expect(screen.getByRole('list', { name: 'Versions' })).toBeInTheDocument();
    act(() => command('agents.pageFold').run());
    expect(screen.queryByRole('list', { name: 'Versions' })).toBeNull();
    expect(command('agents.pageFold')?.title).toBe('Show the page “Job search”');
  });

  it('unpins: the page leaves, the header offers it back, ⌘K says which', async () => {
    both();
    await screen.findByRole('region', { name: 'Page: Job search' });
    expect(command('agents.pagePin')?.title).toBe('Unpin this conversation’s page');
    expect(screen.queryByRole('button', { name: /Pin the page/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unpin the page' }));
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('agents_page_pin', {
      agentId: 'a1',
      conversation: 'first',
      pinned: false,
    });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Page: Job search' })).toBeNull()
    );
    expect(command('agents.pagePin')?.title).toBe('Pin this conversation’s page');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pin the page “Job search”' }));
      await Promise.resolve();
    });
    await screen.findByRole('region', { name: 'Page: Job search' });
  });

  it('shows nothing for a conversation without a page', async () => {
    invoke.mockImplementation(() => Promise.resolve(null));
    both();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('agents_page', { agentId: 'a1', conversation: 'first' })
    );
    expect(screen.queryByRole('region')).toBeNull();
    expect(command('agents.pagePin')?.when?.()).toBe(false);
  });

  it('reads the page once when the band and the header ask at once', async () => {
    both();
    await screen.findByRole('region', { name: 'Page: Job search' });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'agents_page')).toHaveLength(1);
  });
});
