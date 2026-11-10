/**
 * The Live Activity: one for the team, waiting-on-you first, only the
 * agent's (redacted) name and fixed words ever on the Lock Screen, a clock
 * only when the Mac said when the turn began, and started only while the app
 * is in front.
 */

import type { Agent } from '@shipstudio/companion-protocol';
import { activityProps, activitySteps, liveActivityBuilt } from '../src/lib/liveActivity';
import { palettes } from '../src/lib/theme';
import { agentTint } from '../src/lib/accent';

type Status = Agent['status'];
const agent = (
  id: string,
  state: Status['state'],
  since: number | null,
  more: Partial<Agent> = {}
) =>
  ({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    color: 'blue',
    hidden: false,
    pendingApprovals: 0,
    status: { state, activity: 'Reading the secret plan: token=abc123', since },
    ...more,
  }) as Agent;

describe('what the activity shows', () => {
  it('shows nothing when nobody is busy', () => {
    expect(activityProps([agent('inbox', 'idle', null)])).toBeNull();
    expect(activityProps([])).toBeNull();
  });

  it('leads with the turn that has run longest, and counts the rest', () => {
    const p = activityProps([
      agent('inbox', 'working', 2000),
      agent('finance', 'working', 1000),
      agent('idle', 'idle', null),
    ]);
    expect(p).toMatchObject({ agentId: 'finance', needsYou: false, since: 1000, more: 1 });
    expect(p?.color).toBe(agentTint('blue', 'dark'));
    expect(p?.colorLight).toBe(agentTint('blue', 'light'));
    expect(p?.warn).toBe(palettes.dark.accentWarning);
  });

  it('puts an agent waiting on you first, even over a longer turn', () => {
    const p = activityProps([
      agent('inbox', 'working', 1000),
      agent('finance', 'idle', 5000, { pendingApprovals: 1 }),
    ]);
    expect(p).toMatchObject({ agentId: 'finance', needsYou: true, more: 1 });
  });

  it('shows no clock it wasn’t told, and skips hidden agents', () => {
    const p = activityProps([
      agent('inbox', 'working', null),
      agent('ghost', 'working', 1, { hidden: true }),
    ]);
    expect(p).not.toHaveProperty('since');
    expect(p?.more).toBe(0);
  });

  it('carries only the name (redacted) and fixed fields: never a card, a step or a reply', () => {
    const p = activityProps([
      agent('inbox', 'waiting', 1000, {
        name: 'Deploy bot token=sk_live_abcdefghijklmnop',
        pendingApprovals: 2,
        preview: 'Here is the API key sk_live_abcdefghijklmnop',
      }),
    ]);
    expect(Object.keys(p ?? {}).sort()).toEqual(
      [
        'agentId',
        'color',
        'colorLight',
        'more',
        'name',
        'needsYou',
        'since',
        'warn',
        'warnLight',
      ].sort()
    );
    expect(p?.name).not.toContain('sk_live');
    expect(JSON.stringify(p)).not.toContain('secret plan');
    expect(JSON.stringify(p)).not.toContain('API key');
  });
});

describe('keeping it in step', () => {
  const props = activityProps([agent('inbox', 'working', 1000)])!;

  it('starts one only while the app is in front', () => {
    expect(activitySteps([], props, true)).toEqual([{ kind: 'start', props }]);
    expect(activitySteps([], props, false)).toEqual([]);
  });

  it('updates the one showing and ends any extra; ends all when nobody is busy', () => {
    expect(activitySteps(['a', 'b'], props, false)).toEqual([
      { kind: 'update', id: 'a', props },
      { kind: 'end', id: 'b' },
    ]);
    expect(activitySteps(['a'], null, true)).toEqual([{ kind: 'end', id: 'a' }]);
  });

  it('is only in an iOS build made with the extension', () => {
    expect(liveActivityBuilt({ liveActivity: true }, 'ios')).toBe(true);
    expect(liveActivityBuilt({ liveActivity: true }, 'android')).toBe(false);
    expect(liveActivityBuilt({}, 'ios')).toBe(false);
    expect(liveActivityBuilt(undefined, 'ios')).toBe(false);
  });
});
