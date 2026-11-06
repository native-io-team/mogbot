import { describe, expect, it } from 'vitest';
import type { AgentStatus } from './model';
import { agentsAtWork, atWorkText, sameFolder } from './work';

const site = '/Users/sam/Desktop/Projects/lumen-site';

const at = (
  id: string,
  state: AgentStatus['state'],
  project: string | undefined,
  over: { since?: number; pendingApprovals?: number; hidden?: boolean } = {}
) => ({
  id,
  hidden: over.hidden ?? false,
  pendingApprovals: over.pendingApprovals ?? 0,
  status: {
    state,
    activity: 'Running the build',
    since: over.since ?? 0,
    work:
      state === 'idle'
        ? undefined
        : {
            startedAt: 0,
            stepCount: 1,
            steps: [],
            fileCount: 0,
            project,
            current: {
              kind: 'command' as const,
              label: 'Running the build',
              startedAt: 0,
              streams: false,
              canStop: false,
            },
          },
  },
});

describe('agents at work in a project', () => {
  it('lists only turns the Mac says are working in that folder, waiting first', () => {
    const agents = [
      at('builder', 'working', site, { since: 1 }),
      at('elsewhere', 'working', '/Users/sam/ShipStudio/acme-marketing'),
      at('nowhere', 'working', undefined),
      at('idle', 'idle', site),
      at('hidden', 'working', site, { hidden: true }),
      at('asks', 'working', `${site}/`, { since: 2, pendingApprovals: 1 }),
    ];
    expect(agentsAtWork(agents, site).map((a) => a.id)).toEqual(['asks', 'builder']);
    // A folder whose name merely starts the same is another folder.
    expect(agentsAtWork(agents, '/Users/sam/Desktop/Projects/lumen')).toEqual([]);
    expect(sameFolder(`${site}//`, site)).toBe(true);
  });

  it('says the step it is on, or that it needs you', () => {
    expect(atWorkText(at('builder', 'working', site), 'Running the build', 0)).toBe(
      'Running the build'
    );
    expect(atWorkText(at('asks', 'waiting', site), null, 0)).toBe('needs you');
  });
});
