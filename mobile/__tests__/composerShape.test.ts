/**
 * The field's shape: an empty field is always the one-line capsule, at any
 * width, and the card comes only from words that no longer fit, a new line,
 * files or listening (components/Composer.tsx, `ComposerField`). The engine
 * chip's choices: only ready engines, only the models the Mac lists.
 */

import type { Agent, EngineInfo } from '@shipstudio/companion-protocol';
import { fieldIsCard } from '../src/lib/composer';
import { currentModels, otherEngines } from '../src/lib/agentEngine';

const base = { listening: false, hasTop: false, value: '', width: 0, oneLine: 0, room: 0 };

describe('fieldIsCard', () => {
  it('empty is a capsule at any width, however the room measured', () => {
    for (const width of [0, 1, 120, 280, 320, 402, 900]) {
      for (const room of [-200, -1, 0, 1, 40, 200, 700]) {
        // `oneLine` of an empty measuring line is 0, but a stale reading must not matter either.
        for (const oneLine of [0, 5, 500]) {
          expect(fieldIsCard({ ...base, width, room, oneLine })).toBe(false);
        }
      }
    }
  });

  it('words that fit stay a capsule; words that do not fit become a card', () => {
    const f = { ...base, value: 'Hello', width: 360, room: 200 };
    expect(fieldIsCard({ ...f, oneLine: 120 })).toBe(false);
    expect(fieldIsCard({ ...f, oneLine: 201 })).toBe(true);
  });

  it('is not a card before anything is laid out, or while the room is not settled', () => {
    expect(fieldIsCard({ ...base, value: 'Hello', width: 0, room: 100, oneLine: 400 })).toBe(false);
    expect(fieldIsCard({ ...base, value: 'Hello', width: 300, room: -20, oneLine: 10 })).toBe(
      false
    );
  });

  it('a new line, files or listening make a card, even when empty', () => {
    expect(fieldIsCard({ ...base, value: 'a\nb', width: 360, room: 200 })).toBe(true);
    expect(fieldIsCard({ ...base, hasTop: true })).toBe(true);
    expect(fieldIsCard({ ...base, listening: true })).toBe(true);
  });
});

const ENGINES: EngineInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    installed: true,
    signedIn: true,
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
    models: [{ value: 'gpt-5-codex', label: 'GPT-5 Codex' }],
  },
];
const agent = (over: Record<string, unknown> = {}) =>
  ({ engine: 'claude', model: 'opus', status: { state: 'idle' }, ...over }) as unknown as Agent;

describe('the engine chip', () => {
  it('lists the models of its engine with the current one marked', () => {
    const rows = currentModels(agent(), ENGINES);
    expect(rows.map((r) => [r.label, r.current])).toEqual([
      ['Default', false],
      ['Smartest', true],
      ['Balanced', false],
    ]);
  });

  it('marks the engine default when it has no model', () => {
    expect(currentModels(agent({ model: null }), ENGINES)[0]).toMatchObject({ current: true });
  });

  it('offers only engines that are installed and signed in', () => {
    expect(otherEngines(agent(), ENGINES).map((e) => e.id)).toEqual(['codex']);
    const out = ENGINES.map((e) => (e.id === 'codex' ? { ...e, signedIn: false } : e));
    expect(otherEngines(agent(), out)).toEqual([]);
    const gone = ENGINES.map((e) => (e.id === 'codex' ? { ...e, installed: false } : e));
    expect(otherEngines(agent(), gone)).toEqual([]);
  });
});
