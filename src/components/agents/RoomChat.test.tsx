import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ToastContext')>()),
  useOptionalToast: () => ({ showToast: toast }),
}));

import { RoomChat } from './RoomChat';
import { AgentProjectsProvider } from './AgentProject';
import { takeHandedRevision } from '../../lib/agentRooms';
import { __resetAgentsStore, loadRoomMessages, refreshRooms } from '../../lib/agentsStore';
import { RoomWorkingPlace } from './AgentRoomParts';
import { WorkingIndicator } from './AgentChatItems';
import type { Agent, AgentMessage } from '../../lib/agents';
import type { Room } from '../../lib/agentRooms';

const agent = (id: string, name: string, color: string): Agent =>
  ({
    id,
    name,
    color,
    role: '',
    home: `/h/${id}`,
    engine: 'claude',
    status: { state: 'idle', activity: null, since: null },
  }) as Agent;

const fin = agent('fin', 'Finance', 'orange');
const ops = agent('ops', 'Ops', 'teal');
const byId = new Map([fin, ops].map((a) => [a.id, a]));

const room = (over: Partial<Room> = {}): Room => ({
  id: 'r1',
  name: 'Month end',
  members: ['fin', 'ops'],
  muted: false,
  createdAt: 0,
  lastActivityAt: 0,
  unread: 0,
  turnsUsed: 0,
  turnCap: 8,
  waiting: [],
  ...over,
});

const THREAD: AgentMessage[] = [
  {
    id: 'u1',
    agentId: '',
    room: 'r1',
    ts: 1,
    kind: 'user',
    text: 'Is Northwind paid?',
    mentions: [{ id: 'fin', name: 'Finance' }],
  },
  { id: 'a1', agentId: 'fin', room: 'r1', ts: 2, kind: 'agent', text: 'Not yet. @Ops can chase.' },
  { id: 'a2', agentId: 'ops', room: 'r1', ts: 3, kind: 'agent', text: 'Chasing today.' },
];

// jsdom has no ResizeObserver; the chat only uses it to keep to the bottom.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const sends: Record<string, unknown>[] = [];
let thread: AgentMessage[] = THREAD;
let rooms: Room[] = [];

beforeEach(() => {
  sends.length = 0;
  mockIPC(
    (cmd, args) => {
      if (cmd === 'agents_room_messages') return thread;
      if (cmd === 'agents_room_send') {
        const a = args as Record<string, unknown>;
        sends.push(a);
        return {
          message: { id: 'u2', agentId: '', room: 'r1', ts: 9, kind: 'user', text: a.text },
          asked: [],
        };
      }
      if (cmd === 'agents_rooms') return rooms;
      if (cmd === 'agents_overview') return { agents: [fin, ops], engineReady: true, engines: [] };
      return null;
    },
    { shouldMockEvents: true }
  );
});

afterEach(() => {
  thread = THREAD;
  rooms = [];
  cleanup();
  __resetAgentsStore();
  clearMocks();
});

const actions = { onEditRoom: vi.fn(), onToggleRoomMuted: vi.fn(), onDeleteRoom: vi.fn() };

async function open(r: Room, agents = byId, onOpenAgent = vi.fn()) {
  await act(() => loadRoomMessages(r.id));
  render(
    <AgentProjectsProvider onOpenProject={vi.fn()}>
      <RoomChat room={r} agentsById={agents} onOpenAgent={onOpenAgent} {...actions} />
    </AgentProjectsProvider>
  );
  return onOpenAgent;
}

const PROJECT = '/u/ShipStudio/acme-site';
const COPY = { id: 'copy-1', path: '/u/ShipStudio/.worktrees/acme-site/x', branch: 'acme-site/x' };
const CHANGES: AgentMessage = {
  id: 'c1',
  agentId: 'fin',
  room: 'r1',
  ts: 4,
  kind: 'changes',
  text: 'Changed 1 file in a copy of acme-site',
  changes: {
    project: PROJECT,
    from: 'base',
    to: 'now',
    files: [{ path: 'index.html', status: 'modified', added: 1, removed: 1 }],
    fileCount: 1,
    added: 1,
    removed: 1,
    copy: COPY,
  },
};
const RESULT: AgentMessage = {
  id: 'res-msg',
  agentId: 'fin',
  room: 'r1',
  ts: 5,
  kind: 'agent',
  text: 'Every invoice on one page.',
  result: {
    id: 'res-1',
    version: 1,
    title: 'October summary',
    summary: 'Every invoice on one page.',
    items: [],
    checked: [],
    notVerified: [],
  },
};

describe('RoomChat', () => {
  it('shows each agent under its own name and who your message was for', async () => {
    await open(room());
    // Finance's @Ops is tinted in Ops's colour, as your own mentions are.
    const tinted = document.querySelector('.agent-room__prose .agent-mention');
    expect(tinted?.textContent).toBe('@Ops');
    expect(tinted?.getAttribute('data-color')).toBe('teal');
    expect(tinted?.parentElement?.textContent).toBe('Not yet. @Ops can chase.');
    const names = [...document.querySelectorAll('.agent-room__speaker-name')].map(
      (n) => n.textContent
    );
    expect(names).toEqual(['FIFinance', 'OPOps']);
    expect(document.querySelector('.agent-room__speaker-name[data-color="orange"]')).toBeTruthy();
    expect(screen.getByText('To Finance')).toBeTruthy();
  });

  it('asks who should answer when nobody is named and there is no lead', async () => {
    await open(room());
    const input = screen.getByLabelText('Message Month end');
    fireEvent.change(input, { target: { value: 'Anything overdue?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sends).toHaveLength(0);
    expect(screen.getByRole('group', { name: 'Who should answer?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ops/ }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ roomId: 'r1', text: 'Anything overdue?', mentions: ['ops'] });
  });

  it('sends to the lead without asking, and @everyone to everyone', async () => {
    await open(room({ lead: 'fin' }));
    const input = screen.getByLabelText('Message Month end');
    fireEvent.change(input, { target: { value: 'Status?' } });
    expect(screen.getByText('To Finance · @ someone else, or @everyone')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sends).toHaveLength(1));
    // The lead is the backend's default: nothing named.
    expect(sends[0].mentions).toBeUndefined();
    fireEvent.change(input, { target: { value: '@everyone wrap up' } });
    expect(screen.getByText('To everyone · 2 replies')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ everyone: true });
  });

  it('offers only the room’s members and @everyone to mention', async () => {
    await open(room());
    const input = screen.getByLabelText<HTMLTextAreaElement>('Message Month end');
    fireEvent.change(input, { target: { value: '@' } });
    input.setSelectionRange(1, 1);
    fireEvent.select(input);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.some((t) => t?.includes('Finance'))).toBe(true);
    expect(options.some((t) => t?.includes('Everyone'))).toBe(true);
    // The whole room, not an agent: a glyph, never "EV" initials.
    expect(document.querySelector('.agent-mention-menu__group')).toBeTruthy();
    expect(options.some((t) => t?.includes('EV'))).toBe(false);
    // The foot line stays quiet while a name is being picked.
    expect(document.querySelector('.agent-room__address')?.textContent).toBe('');
    expect(options).toHaveLength(3);
  });

  it('offers Keep / Discard for a member’s open copy, as its own chat does', async () => {
    thread = [...THREAD, CHANGES];
    const bound = {
      ...fin,
      project: PROJECT,
      copy: { ...COPY, project: PROJECT, base: 'abc', createdAt: 1, deps: true },
    } as Agent;
    await open(room(), new Map([bound, ops].map((a) => [a.id, a])));
    expect(await screen.findByRole('button', { name: 'Keep changes' })).toBeTruthy();
  });

  it('asks for changes to a member’s result in that member’s own chat', async () => {
    thread = [...THREAD, RESULT];
    const onOpenAgent = await open(room());
    fireEvent.click(screen.getByRole('button', { name: /Ask for changes/ }));
    expect(onOpenAgent).toHaveBeenCalledWith('fin');
    expect(takeHandedRevision('fin')).toMatchObject({ id: 'res-1', version: 1 });
    expect(takeHandedRevision('fin')).toBeNull();
  });

  it('says when a room is down to one member, and offers to add someone or delete it', async () => {
    await open(room({ members: ['fin'] }));
    expect(screen.getByText('Only Finance is left in this room')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add members' }));
    expect(actions.onEditRoom).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete room' }));
    expect(actions.onDeleteRoom).toHaveBeenCalled();
  });
});

describe('an agent’s own chat while it answers in a room', () => {
  it('says where it is replying, with a way there', async () => {
    rooms = [room()];
    await act(() => refreshRooms());
    const onOpenRoom = vi.fn();
    render(
      <WorkingIndicator
        activity="Thinking"
        place={<RoomWorkingPlace roomId="r1" onOpenRoom={onOpenRoom} />}
      />
    );
    expect(screen.getByText(/Replying in/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Month end' }));
    expect(onOpenRoom).toHaveBeenCalledWith('room:r1');
  });
});
