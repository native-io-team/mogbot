import { describe, expect, it } from 'vitest';
import { layoutPalette } from './paletteLayout';
import type { Command, CommandCategory } from '../../commands/types';
import type { RankedCommand } from '../../commands/useRankedCommands';

const cmd = (id: string, category: CommandCategory, score = 0.5, frecency = 0): RankedCommand => ({
  id,
  title: id,
  category,
  run: () => undefined,
  _score: score,
  _frecency: frecency,
});

const ask: Command = {
  id: 'agents.askChief',
  title: 'Ask Chief of Staff',
  category: 'action',
  fallback: true,
  run: () => undefined,
};

describe('layoutPalette', () => {
  it('puts agents commands under Agents, first on the desk', () => {
    const ranked = [cmd('modal.settings', 'settings'), cmd('agents.new', 'navigation')];
    const { sections } = layoutPalette({
      ranked,
      fallbacks: [],
      tab: 'all',
      context: 'home',
      query: '',
    });
    expect(sections.map((s) => s.label)).toEqual(['Agents', 'Settings']);
  });

  it('leads with the project’s actions inside a project', () => {
    const ranked = [cmd('agents.new', 'navigation'), cmd('devserver.restart', 'action')];
    const { sections } = layoutPalette({
      ranked,
      fallbacks: [],
      tab: 'all',
      context: 'project',
      query: '',
    });
    expect(sections.map((s) => s.group)).toEqual(['action', 'agents']);
  });

  it('orders groups by their best match when something is typed, so Enter runs the best', () => {
    const ranked = [cmd('modal.settings', 'settings', 0.95), cmd('agents.new', 'navigation', 0.6)];
    const { rows } = layoutPalette({
      ranked,
      fallbacks: [],
      tab: 'all',
      context: 'home',
      query: 'set',
    });
    expect(rows[0].cmd.id).toBe('modal.settings');
  });

  it('shows recently run commands once, in Recent, when nothing is typed', () => {
    const ranked = [
      cmd('modal.settings', 'settings', 3, 3),
      cmd('agents.new', 'navigation', 1, 1),
      cmd('agents.team', 'navigation', 0, 0),
    ];
    const { sections, rows } = layoutPalette({
      ranked,
      fallbacks: [],
      tab: 'all',
      context: 'home',
      query: '',
    });
    expect(sections[0].label).toBe('Recent');
    expect(sections[0].rows.map((r) => r.cmd.id)).toEqual(['modal.settings', 'agents.new']);
    expect(rows.filter((r) => r.cmd.id === 'agents.new')).toHaveLength(1);
  });

  it('offers the fallbacks, with the query, when nothing anywhere matches', () => {
    const layout = layoutPalette({
      ranked: [],
      fallbacks: [ask],
      tab: 'all',
      context: 'home',
      query: ' invoices ',
    });
    expect(layout.empty).toEqual({ kind: 'no-match', query: 'invoices', elsewhere: 0 });
    expect(layout.rows).toEqual([{ cmd: ask, index: 0, query: 'invoices' }]);
  });

  it('on an empty tab says how many are under All instead of asking the Chief', () => {
    const layout = layoutPalette({
      ranked: [cmd('agents.new', 'navigation')],
      fallbacks: [ask],
      tab: 'settings',
      context: 'home',
      query: 'new',
    });
    expect(layout.empty).toEqual({ kind: 'no-match', query: 'new', elsewhere: 1 });
    expect(layout.rows).toEqual([]);
  });

  it('drops the group header on a single tab', () => {
    const { sections } = layoutPalette({
      ranked: [cmd('agents.new', 'navigation')],
      fallbacks: [],
      tab: 'agents',
      context: 'home',
      query: '',
    });
    expect(sections[0].label).toBeNull();
  });
});
