import type { Agent, TeamSetupView } from '@shipstudio/companion-protocol';
import { attentionCounts, nextNeedsYou } from '../src/lib/agents';
import { buildHome, quietAgentIds } from '../src/lib/home';
import { feedItems } from '../src/lib/needsYou';
import { agent, msg } from './helpers';

const a = (id: string, over: Partial<Agent> = {}) =>
  agent({ id, name: id, isMain: false, pinned: false, hidden: false, lastActivityAt: 0, ...over });
const waiting = { pendingApprovals: 1 } as const;

/** 16 imported agents waiting on logins, as the owner's phone had: setup open, none greeted. */
function imported(n = 16) {
  const team = Array.from({ length: n }, (_, i) =>
    a(`imp${i}`, { lastActivityAt: 100 + i, ...(i < 5 ? waiting : {}) })
  );
  const setup: TeamSetupView = {
    id: 's',
    source: 'Grok Bot',
    steps: [
      {
        id: 'hello',
        state: 'open',
        agents: team.map((t) => ({
          agentId: t.id,
          agentName: t.name,
          color: 'blue',
          state: 'quiet' as const,
        })),
      },
    ],
    done: 0,
    total: 1,
    complete: false,
    agents: n,
    setAside: 0,
    dismissed: false,
  } as TeamSetupView;
  return { team, setup };
}

describe('Home: the Chief first, then pinned, then the rest', () => {
  const chief = a('chief', { isMain: true, pinned: true, lastActivityAt: 1 });

  it('the Chief is always the first row, even when it is the oldest and others need you', () => {
    const { team, setup } = imported();
    const home = buildHome([...team, chief], setup);
    expect(home.chief?.id).toBe('chief');
    expect([...home.pinned, ...home.rest].some((x) => x.id === 'chief')).toBe(false);
  });

  it('agents being set up are quiet, and leave the counts to the checklist', () => {
    const { team, setup } = imported();
    const home = buildHome([chief, ...team], setup);
    expect(home.quiet.size).toBe(16);
    expect(attentionCounts([chief, ...team], setup).needYou).toBe(0);
    expect(nextNeedsYou([chief, ...team], {}, home.quiet)).toBeNull();
  });

  it('no bar for what waits on you: the Catch up tab says it, once', () => {
    const designer = a('Designer', { lastActivityAt: 50, ...waiting });
    const home = buildHome([chief, designer], null);
    expect(home).not.toHaveProperty('bar');
    // The waiting agent still sorts up, where its row's own label says why.
    expect(home.rest.map((x) => x.id)).toEqual(['Designer']);
  });

  it('pinned next, then the rest: what needs you first, then most recent', () => {
    const pinned = a('Pinned', { pinned: true, lastActivityAt: 5 });
    const old = a('Old', { lastActivityAt: 10 });
    const fresh = a('Fresh', { lastActivityAt: 30 });
    const asking = a('Asking', { lastActivityAt: 20, ...waiting });
    const hidden = a('Hidden', { hidden: true, lastActivityAt: 99 });
    const home = buildHome([old, fresh, asking, pinned, hidden, chief], null);
    expect(home.pinned.map((x) => x.id)).toEqual(['Pinned']);
    expect(home.rest.map((x) => x.id)).toEqual(['Asking', 'Fresh', 'Old']);
    expect(home.hidden.map((x) => x.id)).toEqual(['Hidden']);
  });

  it('a finished or dismissed setup quiets no one', () => {
    const { setup } = imported(3);
    expect(quietAgentIds({ ...setup, complete: true }).size).toBe(0);
    expect(quietAgentIds({ ...setup, dismissed: true }).size).toBe(0);
  });
});

describe('one count: the cards the list shows', () => {
  const card = (id: string, agentId: string, ts: number) =>
    msg(id, ts, {
      agentId,
      kind: 'approval',
      text: '',
      approval: { requestId: id, title: 'Run a command', detail: 'ls', status: 'pending' },
    });

  it('counts cards, not agents: the Chief with three requests is three', () => {
    const chief = a('chief', { isMain: true, pendingApprovals: 3 });
    const team = Array.from({ length: 4 }, (_, i) => a(`t${i}`, { lastActivityAt: i, ...waiting }));
    const chats = {
      chief: { messages: [card('c1', 'chief', 1), card('c2', 'chief', 2), card('c3', 'chief', 3)] },
      ...Object.fromEntries(team.map((t, i) => [t.id, { messages: [card(`m${i}`, t.id, i)] }])),
    };
    // Five agents wait, seven requests: the badge says what the list shows.
    expect(attentionCounts([chief, ...team]).needYou).toBe(5);
    expect(feedItems([chief, ...team], chats, null)).toHaveLength(7);
  });

  it('an agent whose cards this phone hasn’t loaded yet is one row until they are', () => {
    const designer = a('Designer', { pendingApprovals: 2 });
    expect(feedItems([designer], {}, null)).toHaveLength(1);
  });
});
