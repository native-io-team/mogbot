import { afterEach, describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import {
  __resetAgentsStore,
  ensureViewing,
  getAgentsSnapshot,
  loadMessages,
  openConversation,
  readChat,
  startConversation,
  upsertMessage,
} from './agentsStore';
import {
  conversationKey,
  conversationOfKey,
  lineConversation,
  type Conversations,
} from './agentConversations';
import type { Agent, AgentMessage } from './agents';

const line = (id: string, conversation?: string): AgentMessage => ({
  id,
  agentId: 'a',
  ts: Number(id.replace(/\D/g, '')) || 1,
  kind: 'agent',
  text: id,
  ...(conversation ? { conversation } : {}),
});

const list = (current: string, ids = ['first', 'c2']): Conversations => ({
  agentId: 'a',
  current,
  items: ids.map((id) => ({
    id,
    title: id,
    named: false,
    createdAt: 1,
    lastActivityAt: 1,
    current: id === current,
    loaded: id === 'first',
    waiting: 0,
  })),
  routines: {},
});

describe('conversation keys', () => {
  it('say their agent and conversation, and nothing else does', () => {
    expect(conversationOfKey(conversationKey('a', 'c2'))).toEqual({
      agentId: 'a',
      conversation: 'c2',
    });
    expect(conversationOfKey('a')).toBeNull();
    expect(conversationOfKey('room:r1')).toBeNull();
  });

  it('place a line the Mac didn’t stamp in the conversation its engine has loaded', () => {
    const agent = { conversations: { loaded: 'c2' } } as Agent;
    expect(lineConversation(line('m1', 'c9'), agent)).toBe('c9');
    expect(lineConversation(line('m1'), agent)).toBe('c2');
    expect(lineConversation(line('m1'), undefined)).toBe('first');
  });
});

describe('a conversation’s chat in the store', () => {
  afterEach(() => __resetAgentsStore());

  it('reads only its own lines and gets only its own events', async () => {
    const asked: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      if (cmd === 'agents_messages') {
        asked.push(args as Record<string, unknown>);
        return [line('m1', 'c2')];
      }
      return null;
    });
    const key = conversationKey('a', 'c2');
    await loadMessages(key);
    expect(asked[0]).toMatchObject({ agentId: 'a', conversation: 'c2' });
    await loadMessages('a');
    upsertMessage(line('m2', 'c2'));
    upsertMessage(line('m3', 'first'));
    const s = getAgentsSnapshot();
    expect(s.messages[key].map((m) => m.id)).toEqual(['m1', 'm2']);
    // The agent's whole chat keeps every line: its cards are read there.
    expect(s.messages.a.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('opens where the user last was, and follows New conversation and a pick', async () => {
    const called: string[] = [];
    mockIPC((cmd, args) => {
      called.push(cmd);
      const a = args as Record<string, unknown>;
      if (cmd === 'agents_conversations') return list('c2');
      if (cmd === 'agents_conversation_new') return list('c3', ['first', 'c2', 'c3']);
      if (cmd === 'agents_conversation_select') return list(String(a.conversationId));
      if (cmd === 'agents_messages') return [];
      return null;
    });
    expect(await ensureViewing('a')).toBe('c2');
    expect(getAgentsSnapshot().viewing.a).toBe('c2');
    expect(await startConversation('a')).toBe('c3');
    expect(getAgentsSnapshot().viewing.a).toBe('c3');
    expect(getAgentsSnapshot().conversations.a.items).toHaveLength(3);
    await openConversation('a', 'first');
    expect(getAgentsSnapshot().viewing.a).toBe('first');
    expect(called).toContain('agents_conversation_select');
  });

  it('reads a chat’s log, its conversation and that page at once, each once', async () => {
    const called: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mockIPC(async (cmd, args) => {
      const a = args as Record<string, unknown>;
      called.push(cmd === 'agents_messages' ? `messages:${(a.conversation as string) ?? ''}` : cmd);
      if (cmd === 'agents_messages' && !a.conversation) await gate;
      if (cmd === 'agents_conversations') return list('c2');
      if (cmd === 'agents_messages') return [line('m1', 'c2')];
      return null;
    });
    readChat('a');
    // The chat's own ask, while the first is still out, asks nothing again.
    const viewing = ensureViewing('a');
    await viewing;
    await new Promise((r) => setTimeout(r, 0));
    // The conversation's page came back while the log was still being read.
    expect(getAgentsSnapshot().messages[conversationKey('a', 'c2')]).toHaveLength(1);
    expect(getAgentsSnapshot().messages.a).toBeUndefined();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(getAgentsSnapshot().messages.a).toHaveLength(1);
    expect(called.sort()).toEqual(['agents_conversations', 'messages:', 'messages:c2']);
  });

  it('falls back to the first conversation when the Mac can’t say', async () => {
    mockIPC(() => {
      throw new Error('unknown command');
    });
    expect(await ensureViewing('a')).toBe('first');
  });
});
