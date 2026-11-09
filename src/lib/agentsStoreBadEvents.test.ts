/**
 * An event the store can't apply (a payload from another build, or a bug on
 * the Mac's side) is logged and the store reads everything again, rather
 * than throwing inside the listener and leaving a chat or a row stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import {
  __flushResync,
  __resetAgentsStore,
  getAgentsSnapshot,
  refreshAgents,
  loadMessages,
  subscribeAgents,
} from './agentsStore';
import { AGENT_EVENTS } from './agents';

const logged = vi.hoisted(() => vi.fn());
vi.mock('./logger', () => ({
  logger: { error: logged, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), logError: vi.fn() },
}));

const agent = (id: string) => ({ id, name: id, status: { state: 'idle' } });
let calls: string[] = [];
let overview: unknown = { agents: [agent('a')], engineReady: true };

beforeEach(() => {
  calls = [];
  overview = { agents: [agent('a')], engineReady: true };
  mockIPC(
    (cmd) => {
      calls.push(cmd);
      if (cmd === 'agents_overview') return overview;
      if (cmd === 'agents_rooms') return [];
      if (cmd === 'agents_messages') return [];
      return null;
    },
    { shouldMockEvents: true }
  );
});

afterEach(() => {
  __resetAgentsStore();
  clearMocks();
  logged.mockClear();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

async function started() {
  const unsubscribe = subscribeAgents(() => {});
  await settle();
  await settle();
  calls = [];
  return unsubscribe;
}

const unreadable: [string, string, unknown][] = [
  ['a message with no id', AGENT_EVENTS.message, { agentId: 'a', ts: 1 }],
  ['a message that is null', AGENT_EVENTS.message, null],
  ['a message that is a string', AGENT_EVENTS.message, 'hello'],
  ['a status with no status', AGENT_EVENTS.status, { agentId: 'a' }],
  ['a status that is a list', AGENT_EVENTS.status, [1, 2]],
  ['a draft with no text', AGENT_EVENTS.draft, { agentId: 'a', id: 'd' }],
];

describe('an event that can’t be read', () => {
  it.each(unreadable)('%s: logged, and the store reads everything again', async (_, name, p) => {
    const unsubscribe = await started();
    const before = getAgentsSnapshot();
    await emit(name, p);
    await settle();
    expect(getAgentsSnapshot().agents).toBe(before.agents);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('couldn’t be applied'),
      expect.anything()
    );
    expect(__flushResync()).toBe(true);
    await settle();
    expect(calls).toContain('agents_overview');
    expect(calls).toContain('agents_rooms');
    unsubscribe();
  });

  it('a burst is one re-read', async () => {
    const unsubscribe = await started();
    await emit(AGENT_EVENTS.message, null);
    await emit(AGENT_EVENTS.message, 7);
    await emit(AGENT_EVENTS.draft, {});
    await settle();
    expect(__flushResync()).toBe(true);
    expect(__flushResync()).toBe(false);
    unsubscribe();
  });

  it('an open chat is read again too', async () => {
    const unsubscribe = await started();
    await loadMessages('a');
    calls = [];
    await emit(AGENT_EVENTS.status, 'bad');
    await settle();
    __flushResync();
    await settle();
    expect(calls).toContain('agents_messages');
    unsubscribe();
  });

  it('a good event after a bad one still applies', async () => {
    const unsubscribe = await started();
    await emit(AGENT_EVENTS.status, { agentId: 'a' });
    await emit(AGENT_EVENTS.status, { agentId: 'a', status: { state: 'working', activity: null } });
    await new Promise((r) => setTimeout(r, 80));
    expect(getAgentsSnapshot().agents[0].status.state).toBe('working');
    unsubscribe();
  });
});

describe('an overview that can’t be read', () => {
  it('agents that are not a list read as none, without an error', async () => {
    overview = { agents: { a: 1 }, engineReady: true };
    await refreshAgents();
    expect(getAgentsSnapshot().agents).toEqual([]);
    expect(getAgentsSnapshot().error).toBeNull();
  });

  it('an entry with no id is dropped, the rest kept', async () => {
    overview = { agents: [agent('a'), null, { name: 'no id' }, agent('b')], engineReady: true };
    await refreshAgents();
    expect(getAgentsSnapshot().agents.map((a) => a.id)).toEqual(['a', 'b']);
  });
});
