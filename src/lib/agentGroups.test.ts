import { beforeEach, describe, expect, it } from 'vitest';
import {
  addGroup,
  getAgentGroups,
  moveToGroup,
  parseGroups,
  removeGroup,
  sectionAgents,
  setGroupMode,
  toggleCollapsed,
} from './agentGroups';
import type { Agent } from './agents';

const agent = (id: string, project?: string) => ({ id, name: id, project }) as unknown as Agent;
const name = (path: string) => path.split('/').pop() ?? path;

describe('parseGroups', () => {
  it('reads anything malformed as off', () => {
    expect(parseGroups(null).mode).toBe('off');
    expect(parseGroups('{nope').mode).toBe('off');
    expect(parseGroups('{"mode":"weird"}').mode).toBe('off');
  });

  it('drops assignments to groups that no longer exist', () => {
    const got = parseGroups(
      JSON.stringify({
        mode: 'custom',
        groups: [
          { id: 'g1', name: 'Acme' },
          { id: 'g2', name: '' },
        ],
        assign: { a: 'g1', b: 'g2', c: 'gone' },
        collapsed: ['group:g1', 3],
      })
    );
    expect(got.groups).toEqual([{ id: 'g1', name: 'Acme' }]);
    expect(got.assign).toEqual({ a: 'g1' });
    expect(got.collapsed).toEqual(['group:g1']);
  });
});

describe('sectionAgents', () => {
  const list = [agent('a', '/p/zeta'), agent('b'), agent('c', '/p/acme'), agent('d', '/p/zeta')];

  it('off: one untitled section, in the order given', () => {
    const got = sectionAgents(list, { mode: 'off', groups: [], assign: {} }, name);
    expect(got).toHaveLength(1);
    expect(got[0].agents.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('by project: one per bound project by name, the rest last', () => {
    const got = sectionAgents(list, { mode: 'project', groups: [], assign: {} }, name);
    expect(got.map((s) => [s.title, s.agents.map((a) => a.id)])).toEqual([
      ['acme', ['c']],
      ['zeta', ['a', 'd']],
      ['Not in a project', ['b']],
    ]);
  });

  it('your own groups: in your order, empty ones too, then Ungrouped', () => {
    const got = sectionAgents(
      list,
      {
        mode: 'custom',
        groups: [
          { id: 'g1', name: 'Client' },
          { id: 'g2', name: 'Empty' },
        ],
        assign: { c: 'g1', a: 'g1' },
      },
      name
    );
    expect(got.map((s) => [s.title, s.agents.map((a) => a.id)])).toEqual([
      ['Client', ['a', 'c']],
      ['Empty', []],
      ['Ungrouped', ['b', 'd']],
    ]);
    expect(got[0].groupId).toBe('g1');
    expect(got[2].groupId).toBeUndefined();
  });
});

describe('changing groups', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const g of getAgentGroups().groups) removeGroup(g.id);
    setGroupMode('off');
  });

  it('adds, assigns, folds and removes, and keeps it across a reload', () => {
    const id = addGroup('  Acme  ');
    expect(id).not.toBeNull();
    expect(getAgentGroups().mode).toBe('custom');
    expect(addGroup('acme')).toBe(id);
    moveToGroup('scout', id);
    toggleCollapsed(`group:${id}`);
    const saved = parseGroups(localStorage.getItem('shipstudio.agents.groups'));
    expect(saved.assign).toEqual({ scout: id });
    expect(saved.collapsed).toEqual([`group:${id}`]);
    removeGroup(id!);
    expect(getAgentGroups().assign).toEqual({});
    expect(getAgentGroups().collapsed).toEqual([]);
  });

  it('never names a group with nothing', () => {
    expect(addGroup('   ')).toBeNull();
  });
});
