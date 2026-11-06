import type { Agent, TeamSetupView } from '@shipstudio/companion-protocol';
import { attentionCounts, nextNeedsYou } from '../src/lib/agents';
import { barWords, buildHome, quietAgentIds } from '../src/lib/home';
import { agent } from './helpers';

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

describe('Home: the Chief first, one calm bar', () => {
  const chief = a('chief', { isMain: true, pinned: true, lastActivityAt: 1 });

  it('the Chief is always the first row, even when it is the oldest and others need you', () => {
    const { team, setup } = imported();
    const home = buildHome([...team, chief], setup);
    expect(home.chief?.id).toBe('chief');
    expect([...home.pinned, ...home.rest].some((x) => x.id === 'chief')).toBe(false);
  });

  it('agents being set up are quiet: one "setting up your team" bar, not a Needs you section', () => {
    const { team, setup } = imported();
    const home = buildHome([chief, ...team], setup);
    expect(home.bar).toEqual({ kind: 'setup' });
    expect(home.quiet.size).toBe(16);
    expect(barWords(home.bar!, 'Chief of Staff', '0 of 1 done')[0]).toBe(
      'A few things to finish setting up your team'
    );
    // The tab badge and "Open next" leave them to the checklist too.
    expect(attentionCounts([chief, ...team], setup).needYou).toBe(0);
    expect(nextNeedsYou([chief, ...team], {}, home.quiet)).toBeNull();
  });

  it('others waiting: "N agents need your OK", which also points at setup', () => {
    const { team, setup } = imported();
    const designer = a('Designer', { lastActivityAt: 50, ...waiting });
    const writer = a('Writer', {
      lastActivityAt: 60,
      status: { state: 'waiting', activity: null, since: 1 },
    });
    const home = buildHome([chief, designer, writer, ...team], setup);
    expect(home.bar?.kind).toBe('needs');
    expect(barWords(home.bar!, 'Chief of Staff')).toEqual([
      '2 agents need your OK',
      'Writer, Designer · and setting up your team',
    ]);
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
    expect(barWords(home.bar!, 'Chief of Staff')[0]).toBe('Asking needs your OK');
  });

  it('nothing waiting and no setup: no bar', () => {
    expect(buildHome([chief, a('x')], null).bar).toBeNull();
  });

  it('a finished or dismissed setup quiets no one', () => {
    const { team, setup } = imported(3);
    expect(quietAgentIds({ ...setup, complete: true }).size).toBe(0);
    expect(quietAgentIds({ ...setup, dismissed: true }).size).toBe(0);
    expect(buildHome([chief, ...team], { ...setup, complete: true }).bar?.kind).toBe('needs');
  });
});

describe('one count everywhere', () => {
  it('Home’s bar and the tab badge say the same number, the Chief included', () => {
    const chief = a('chief', { isMain: true, pinned: true, ...waiting });
    const team = Array.from({ length: 13 }, (_, i) =>
      a(`t${i}`, { lastActivityAt: i, ...waiting })
    );
    const home = buildHome([chief, ...team], null);
    expect(home.bar?.kind === 'needs' && home.bar.agents.length).toBe(14);
    expect(barWords(home.bar!, 'Chief of Staff')[0]).toBe('14 agents need your OK');
    expect(attentionCounts([chief, ...team]).needYou).toBe(14);
  });

  it('the Chief alone waiting still gets the bar', () => {
    const chief = a('chief', { isMain: true, ...waiting });
    const home = buildHome([chief, a('x')], null);
    expect(barWords(home.bar!, 'Chief of Staff')[0]).toBe('chief needs your OK');
  });
});
