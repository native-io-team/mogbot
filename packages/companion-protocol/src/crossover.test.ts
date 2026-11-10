import { describe, expect, it } from 'vitest';
import {
  awayLine,
  awayStateOf,
  crossoverDetail,
  crossoverOptions,
  crossoverOutcome,
  type CrossoverAsk,
} from './crossover';
import { switcherView, workingLine } from './accountSwitcher';
import type { UsageAccount } from './model';

const NOW = new Date(2026, 10, 9, 13, 0, 0).getTime();
const FOUR = new Date(2026, 10, 9, 16, 0, 0).getTime();

describe('carrying on with the other engine', () => {
  it('offers ask first, carry on with the other engine, or wait', () => {
    expect(crossoverOptions('claude').map((o) => o.label)).toEqual([
      'Ask first',
      'Carry on with Codex',
      'Wait for the refill',
    ]);
    expect(crossoverOptions('codex')[1].label).toBe('Carry on with Claude Code');
    expect(crossoverDetail('claude', 'carry')).toContain('Never for an agent set to one account');
  });

  it('says what an answer means', () => {
    const ask: CrossoverAsk = { from: 'claude', to: 'codex', until: FOUR, resume: true };
    expect(crossoverOutcome(ask, 'allowed', 'Just this time')).toBe(
      'Just this time · carrying on with Codex'
    );
    expect(crossoverOutcome({ ...ask, resume: false }, 'allowed', 'Just this time')).toBe(
      'Just this time · your next message runs on Codex'
    );
    expect(crossoverOutcome(ask, 'pending')).toBeNull();
  });

  it('the account row says the engine is out and where agents carry on, until when', () => {
    const agents = [
      { engine: 'claude' as const, away: { engine: 'codex' as const, since: 1, until: FOUR } },
      { engine: 'claude' as const, away: { engine: 'codex' as const, since: 1 } },
      { engine: 'codex' as const },
    ];
    const state = awayStateOf('claude', agents, NOW)!;
    expect(state).toMatchObject({ home: 'claude', on: 'codex', until: FOUR, count: 2 });
    expect(awayLine(state, NOW)).toMatch(/^Claude Code out · on Codex until 4:00\sPM$/);
    expect(awayStateOf('codex', agents, NOW)).toBeNull();

    const accounts: UsageAccount[] = [
      { id: 'default', engine: 'claude', name: 'Work', thisMac: true, signedIn: true, out: true },
    ];
    const [claude] = switcherView(accounts, null, { now: NOW, engines: ['claude'] });
    const line = workingLine(claude, state, NOW)!;
    expect(line.name).toBe('Claude out');
    expect(line.room).toBe('on Codex');
    expect(line.detail).toMatch(
      /carrying on with Codex until 4:00\sPM, then back to Claude Code\.$/
    );
    expect(line.tone).toBe('warning');
    expect(line.detail).toContain('2 agents are carrying on with Codex');
    // Nobody away: the row is as before.
    expect(workingLine(claude, null, NOW)?.name).toBe('Work');
  });
});
