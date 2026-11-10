/**
 * The composer's chip says the model ("Opus 5.5") and the effort ("· High"),
 * the engine only when nothing names a model; the version only as the engine
 * reported it (lib/agentControls.ts).
 */

import type { Agent, EngineInfo } from '@shipstudio/companion-protocol';
import {
  chipLabel,
  claudeModelName,
  controlsLocked,
  effortRows,
  modelShortName,
} from '../src/lib/agentControls';

const ENGINES: EngineInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    signedIn: true,
    asks: true,
    models: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    installed: true,
    signedIn: true,
    asks: true,
    models: [{ value: 'gpt-5-codex', label: 'GPT-5 Codex' }],
  },
];

const agent = (over: Partial<Agent> = {}) =>
  ({ engine: 'claude', model: null, status: { state: 'idle' }, ...over }) as Agent;
const reading = (model: string) => ({ used: 1, window: 200_000, at: 1, model });

describe('claudeModelName', () => {
  it('names Claude’s ids as Claude does, never guessing', () => {
    expect(claudeModelName('claude-opus-5-5')).toEqual({ family: 'opus', name: 'Opus 5.5' });
    expect(claudeModelName('claude-sonnet-4-20250514')?.name).toBe('Sonnet 4');
    expect(claudeModelName('claude-sonnet-4-5-20250929')?.name).toBe('Sonnet 4.5');
    expect(claudeModelName('claude-3-5-haiku-20241022')?.name).toBe('Haiku 3.5');
    expect(claudeModelName('claude-opus-4-6[1m]')?.name).toBe('Opus 4.6');
    for (const other of ['gpt-5-codex', 'opus', 'claude-mystery-9', '']) {
      expect(claudeModelName(other)).toBeNull();
    }
  });
});

describe('the chip', () => {
  it('shows the model the engine reported, and the effort after a dot', () => {
    const a = agent({ context: reading('claude-opus-5-5'), effort: 'high' });
    expect(chipLabel(a, ENGINES)).toEqual({
      main: 'Opus 5.5',
      effort: 'High',
      says: 'Runs on Opus 5.5 on Claude Code, High effort',
    });
  });

  it('falls back to the listed name, then to the engine only with no model info', () => {
    expect(chipLabel(agent({ model: 'sonnet' }), ENGINES).main).toBe('Sonnet');
    const bare = chipLabel(agent(), ENGINES);
    expect(bare.main).toBe('Claude Code');
    expect(bare.effort).toBeNull();
    expect(bare.says).toBe('Runs on Claude Code, its default model');
  });

  it('a reading from before a model switch doesn’t win over the choice', () => {
    expect(modelShortName(agent({ model: 'sonnet', context: reading('claude-opus-5-5') }), ENGINES)).toBe(
      'Sonnet'
    );
    expect(modelShortName(agent({ model: 'opus', context: reading('claude-opus-5-5') }), ENGINES)).toBe(
      'Opus 5.5'
    );
  });

  it('Codex: the name Codex lists the model under', () => {
    expect(modelShortName(agent({ engine: 'codex', model: 'gpt-5-codex' }), ENGINES)).toBe(
      'GPT-5 Codex'
    );
    expect(modelShortName(agent({ engine: 'codex', context: reading('gpt-5-codex') }), ENGINES)).toBe(
      'GPT-5 Codex'
    );
    expect(chipLabel(agent({ engine: 'codex' }), ENGINES).main).toBe('Codex');
  });

  it('ignores an effort it doesn’t know', () => {
    expect(chipLabel(agent({ effort: 'max' as never }), ENGINES).effort).toBeNull();
  });
});

describe('Agent controls', () => {
  it('offers the engine’s default and the three levels', () => {
    expect(effortRows().map((r) => r.value)).toEqual(['', 'low', 'medium', 'high']);
  });

  it('locks the model and effort while a turn runs or it’s driven', () => {
    expect(controlsLocked(agent())).toBeNull();
    expect(controlsLocked(agent({ status: { state: 'working' } as Agent['status'] }))).toMatch(
      /once it’s done with this/
    );
    expect(controlsLocked(agent({ takeover: {} as Agent['takeover'] }))).toMatch(/hand it back/);
  });
});
