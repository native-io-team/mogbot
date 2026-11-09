import { describe, expect, it } from 'vitest';
import {
  agentNeedsYou,
  agentsNeedingYou,
  needsYouCount,
  setupHold,
  teamLine,
  workingCount,
} from './attention';
import type { AttentionAgent, AttentionSetup } from './attention';
import cases from './attention-cases.json';

type Case = (typeof cases.cases)[number];

const agentOf = (a: Case['agents'][number]): AttentionAgent => ({
  id: a.id,
  hidden: 'hidden' in a ? Boolean(a.hidden) : false,
  pendingApprovals: a.pendingApprovals,
  failure: 'failure' in a && a.failure ? { kind: a.failure as 'other' } : undefined,
  status: { state: a.state as AttentionAgent['status']['state'] },
});

describe('who needs you (the cases the Dock badge is held to as well)', () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      const hold = {
        held: new Map(Object.entries(c.held as Record<string, number>)),
        quiet: new Set('quiet' in c ? (c.quiet as string[]) : []),
      };
      const agents = c.agents.map(agentOf);
      expect(agents.filter((a) => agentNeedsYou(a, hold)).map((a) => a.id)).toEqual(c.needYou);
    });
  }
});

describe('the checklist', () => {
  const view = (over: Partial<AttentionSetup> = {}) =>
    ({
      complete: false,
      dismissed: false,
      steps: [
        {
          id: 'logins',
          state: 'open',
          logins: [
            { agentId: 'leads', requestId: 'r1' },
            { agentId: 'leads', requestId: 'r2' },
          ],
        },
        { id: 'hello', state: 'open', agents: [{ agentId: 'imp', state: 'quiet' }] },
      ],
      ...over,
    }) as unknown as AttentionSetup;

  it('holds its logins and the agents not met, until it is complete or put away', () => {
    expect(setupHold(view()).held.get('leads')).toBe(2);
    expect([...setupHold(view()).quiet]).toEqual(['imp']);
    expect(setupHold(view({ complete: true })).held.size).toBe(0);
    expect(setupHold(view({ dismissed: true })).quiet.size).toBe(0);
    expect(setupHold(null).held.size).toBe(0);
  });

  it('is one number for every surface, the Chief included', () => {
    const agents = [
      agentOf({ id: 'chief', state: 'waiting', pendingApprovals: 1 }),
      agentOf({ id: 'leads', state: 'idle', pendingApprovals: 2 }),
      agentOf({ id: 'imp', state: 'idle', pendingApprovals: 1 }),
      agentOf({ id: 'hiring', state: 'idle', pendingApprovals: 1 }),
    ];
    expect(needsYouCount(agents, view())).toBe(2);
    expect(agentsNeedingYou(agents, view()).map((a) => a.id)).toEqual(['chief', 'hiring']);
    expect(needsYouCount(agents)).toBe(4);
  });
});

describe('the team line', () => {
  const at = (state: 'idle' | 'working' | 'waiting', takeover?: object) => ({
    status: { state },
    takeover,
  });

  it('counts agents mid-turn, leaving out one taken over', () => {
    expect(workingCount([at('working'), at('idle'), at('waiting'), at('working', {})])).toBe(1);
  });

  it('says how many are working, or that it is quiet', () => {
    expect(teamLine(3)).toBe('3 working');
    expect(teamLine(0)).toBe('All quiet');
  });
});
