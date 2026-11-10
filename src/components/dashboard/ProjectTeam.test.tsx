import { describe, expect, it } from 'vitest';
import { projectTeam } from './ProjectTeam';
import type { Agent } from '../../lib/agents';

const SITE = '/Users/sam/ShipStudio/site';

const agent = (id: string, name: string, over: Partial<Agent> = {}): Agent =>
  ({
    id,
    name,
    color: 'green',
    hidden: false,
    status: { state: 'idle' },
    ...over,
  }) as unknown as Agent;

const working = (activity: string) =>
  ({
    state: 'working',
    activity,
    since: 0,
    work: { startedAt: 0, stepCount: 1, fileCount: 0, doing: activity, steps: [], project: SITE },
  }) as unknown as Agent['status'];

describe('projectTeam', () => {
  it('says nothing about a project no agent works in', () => {
    expect(projectTeam([agent('a', 'Ada')], SITE, 0)).toBeNull();
  });

  it('names a bound agent, and its own copy only when it has one', () => {
    expect(projectTeam([agent('f', 'Finance', { project: SITE })], SITE, 0)?.text).toBe(
      'Finance works here'
    );
    const copy = {
      id: 'c',
      path: '/tmp/c',
      branch: 'b',
      project: SITE,
      base: 'x',
      createdAt: 0,
      deps: false,
    };
    expect(projectTeam([agent('f', 'Finance', { project: SITE, copy })], SITE, 0)?.text).toBe(
      'Finance works here · in its own copy'
    );
  });

  it('puts an agent at work first, with the step it is on', () => {
    const team = projectTeam(
      [
        agent('f', 'Finance', { project: SITE }),
        agent('a', 'Acme Site', { status: working('Running the build') }),
      ],
      SITE,
      0
    );
    expect(team?.members.map((m) => [m.name, m.working])).toEqual([
      ['Acme Site', true],
      ['Finance', false],
    ]);
    expect(team?.text).toBe('Acme Site · Running the build');
  });

  it('marks an agent at work that waits on your OK, so its key is raised and amber', () => {
    const team = projectTeam(
      [agent('a', 'Acme Site', { status: working('Editing Hero.tsx'), pendingApprovals: 1 })],
      SITE,
      0
    );
    expect(team?.members.map((m) => [m.name, m.working, m.waiting])).toEqual([
      ['Acme Site', true, true],
    ]);
  });

  it('leaves out hidden agents and other folders', () => {
    expect(
      projectTeam(
        [
          agent('h', 'Hidden', { project: SITE, hidden: true }),
          agent('o', 'Other', { project: '/x' }),
        ],
        SITE,
        0
      )
    ).toBeNull();
  });
});
