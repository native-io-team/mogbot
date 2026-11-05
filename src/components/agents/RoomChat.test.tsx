import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/ToastContext')>()),
  useOptionalToast: () => ({ showToast: toast }),
}));

import { RoomChat } from './RoomChat';
import { __resetAgentsStore, loadRoomMessages } from '../../lib/agentsStore';
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

beforeEach(() => {
  sends.length = 0;
  mockIPC(
    (cmd, args) => {
      if (cmd === 'agents_room_messages') return THREAD;
      if (cmd === 'agents_room_send') {
        const a = args as Record<string, unknown>;
        sends.push(a);
        return {
          message: { id: 'u2', agentId: '', room: 'r1', ts: 9, kind: 'user', text: a.text },
          asked: [],
        };
      }
      if (cmd === 'agents_rooms') return [];
      if (cmd === 'agents_overview') return { agents: [fin, ops], engineReady: true, engines: [] };
      return null;
    },
    { shouldMockEvents: true }
  );
});

afterEach(() => {
  cleanup();
  __resetAgentsStore();
  clearMocks();
});

const actions = { onEditRoom: vi.fn(), onToggleRoomMuted: vi.fn(), onDeleteRoom: vi.fn() };

async function open(r: Room) {
  await act(() => loadRoomMessages(r.id));
  render(<RoomChat room={r} agentsById={byId} onOpenAgent={vi.fn()} {...actions} />);
}

describe('RoomChat', () => {
  it('shows each agent under its own name and who your message was for', async () => {
    await open(room());
    expect(screen.getByText('Not yet. @Ops can chase.')).toBeTruthy();
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
    expect(options.some((t) => t?.includes('everyone'))).toBe(true);
    expect(options).toHaveLength(3);
  });
});
