import {
  conversationTitle,
  filterConversations,
  othersWaiting,
  routineConversationLine,
  routineMoveChoices,
  type Conversations,
  type WelcomeFrame,
} from '@shipstudio/companion-protocol';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';
import {
  agentOfKey,
  chatKeyFor,
  conversationKey,
  conversationKeyOf,
  conversationOfKey,
  conversationsOffered,
  jumpStep,
} from '../src/lib/conversations';
import { applyEvent, emptySync, mergePage } from '../src/lib/sync';
import { msg } from './helpers';

// The Mac's own list, as `cargo test --lib companion::fixtures` serialized it.
const list = real.agentsConversationRename as Conversations;

const welcome = (methods: string[]) => ({ methods }) as unknown as WelcomeFrame;

describe('conversations are only offered by a Mac that keeps them', () => {
  it('needs the method', () => {
    expect(conversationsOffered(welcome(['agents.conversations']))).toBe(true);
    expect(conversationsOffered(welcome(['agents.messages']))).toBe(false);
    expect(conversationsOffered(null)).toBe(false);
  });

  it('reads an older Mac’s one chat, and waits to know which conversation otherwise', () => {
    expect(chatKeyFor('a', undefined, false)).toBe('a');
    expect(chatKeyFor('a', 'c2', false)).toBe('a');
    expect(chatKeyFor('a', undefined, true)).toBeNull();
    expect(chatKeyFor('a', 'c2', true)).toBe('a#conversation:c2');
  });
});

describe('a conversation’s chat in the store', () => {
  it('has a key of its own that says its agent', () => {
    const key = conversationKey('a1', 'c9');
    expect(conversationOfKey(key)).toEqual({ agentId: 'a1', conversation: 'c9' });
    expect(agentOfKey(key)).toBe('a1');
    expect(conversationOfKey('a1')).toBeNull();
    expect(conversationOfKey('room:r1')).toBeNull();
    expect(agentOfKey('a1')).toBe('a1');
  });

  it('gets each line of its own, and the agent’s whole chat gets every line', () => {
    const first = msg('m1', 1, { agentId: 'a' });
    const second = msg('m2', 2, { agentId: 'a', conversation: 'c2' });
    expect(conversationKeyOf(first)).toBe('a#conversation:first');
    expect(conversationKeyOf(msg('m3', 3, { agentId: 'a', room: 'r1' }))).toBeNull();
    let s = emptySync();
    for (const m of [first, second]) s = applyEvent(s, { type: 'agents.message', message: m });
    expect(s.chats.a.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(s.chats['a#conversation:first'].messages.map((m) => m.id)).toEqual(['m1']);
    expect(s.chats['a#conversation:c2'].messages.map((m) => m.id)).toEqual(['m2']);
  });

  it('pages under its own key', () => {
    const key = conversationKey('a', 'c2');
    const s = mergePage(
      emptySync(),
      key,
      {
        messages: [msg('m2', 2, { agentId: 'a', conversation: 'c2' })],
        asOf: { epoch: 'e', seq: 1 },
        more: false,
      },
      false
    );
    expect(s.chats[key].loaded).toBe(true);
    expect(s.chats.a).toBeUndefined();
  });
});

describe('the words for a conversation', () => {
  it('names it by its title, or plainly before anything is said', () => {
    expect(conversationTitle({ id: 'c1', title: ' Launch ' })).toBe('Launch');
    expect(conversationTitle({ id: 'c1', title: '' })).toBe('New conversation');
    expect(conversationTitle({ id: 'first', title: '' })).toBe('First conversation');
  });

  it('finds one by any of its words, and says which others wait on you', () => {
    expect(filterConversations(list.items, 'LAUNCH plan').map((c) => c.id)).toEqual(['c2']);
    expect(filterConversations(list.items, '')).toHaveLength(list.items.length);
    expect(othersWaiting(list, 'c2')).toBe(1);
    expect(othersWaiting(list, 'first')).toBe(0);
    expect(othersWaiting(null, 'first')).toBe(0);
  });

  it('says which conversation a routine runs in only when there are several', () => {
    expect(routineConversationLine(list, 'ci_1')).toBe('In “Launch plan”');
    expect(routineConversationLine(list, 'other')).toBe('In “Fix the login page”');
    expect(routineConversationLine({ ...list, items: list.items.slice(0, 1) }, 'ci_1')).toBeNull();
  });

  it('offers a routine every other conversation to move to, none with only one', () => {
    expect(routineMoveChoices(list, 'ci_1')).toEqual([{ id: 'first', title: 'Fix the login page' }]);
    expect(routineMoveChoices(list, 'other')).toEqual([{ id: 'c2', title: 'Launch plan' }]);
    expect(routineMoveChoices({ ...list, items: list.items.slice(0, 1) }, 'ci_1')).toEqual([]);
    // Moved back to the first, the Mac keeps nothing for it.
    expect((real.agentsConversationRoutine as Conversations).routines.ci_1).toBeUndefined();
  });
});

describe('a search hit in another conversation', () => {
  it('opens that conversation first, then pages in its own chat', () => {
    expect(jumpStep('a1', 'c2', 'first', true)).toEqual({ kind: 'switch', to: 'c2' });
    expect(jumpStep('a1', 'c2', undefined, true)).toEqual({ kind: 'switch', to: 'c2' });
    expect(jumpStep('a1', 'c2', 'c2', true)).toEqual({
      kind: 'load',
      key: conversationKey('a1', 'c2'),
    });
  });

  it('looks in the one on screen when the hit does not say, and waits until that is known', () => {
    expect(jumpStep('a1', undefined, 'c3', true)).toEqual({
      kind: 'load',
      key: conversationKey('a1', 'c3'),
    });
    expect(jumpStep('a1', undefined, undefined, true)).toEqual({ kind: 'wait' });
  });

  it("reads the agent's one chat on a Mac without conversations", () => {
    expect(jumpStep('a1', 'c2', undefined, false)).toEqual({ kind: 'load', key: 'a1' });
  });
});
