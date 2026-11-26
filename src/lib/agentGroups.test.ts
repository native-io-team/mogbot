import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';

// agentGroups refreshes the store with a fire-and-forget dynamic import; on a slow
// runner the real store's module graph was still loading when the file's
// environment tore down (CI 44460251493). A stub resolves at once.
vi.mock('./agentsStore', () => ({ refreshAgents: vi.fn() }));
import {
  addGroup,
  inYourOrder,
  reorder,
  getAgentGroups,
  moveGroup,
  moveToGroup,
  parseLocal,
  removeGroup,
  sectionAgents,
  setGroupMode,
  shownMode,
  startNamingGroup,
  syncFolders,
  toggleCollapsed,
} from './agentGroups';
import type { Agent } from './agents';

const agent = (id: string, project?: string, pinned = false) =>
  ({ id, name: id, project, pinned }) as unknown as Agent;
const name = (path: string) => path.split('/').pop() ?? path;

describe('parseLocal', () => {
  it('reads anything malformed as nothing chosen', () => {
    expect(parseLocal(null).mode).toBe('off');
    expect(parseLocal('{nope').mode).toBe('off');
    expect(parseLocal('{"mode":"weird"}').mode).toBe('off');
    expect(parseLocal(null).chosenOff).toBe(false);
  });

  it('keeps a window’s old groups to bring to the Mac, dropping the unreadable', () => {
    const got = parseLocal(
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
    expect(got.legacyGroups).toEqual([{ id: 'g1', name: 'Acme' }]);
    expect(got.legacyAssign).toEqual({ a: 'g1' });
    expect(got.collapsed).toEqual(['group:g1']);
  });
});

describe('shownMode', () => {
  it('shows folders once there are any, unless you chose one list or projects', () => {
    expect(shownMode({ mode: 'off', chosenOff: false }, 0, false)).toBe('off');
    expect(shownMode({ mode: 'off', chosenOff: false }, 2, false)).toBe('custom');
    expect(shownMode({ mode: 'off', chosenOff: false }, 0, true)).toBe('custom');
    expect(shownMode({ mode: 'off', chosenOff: true }, 2, false)).toBe('off');
    expect(shownMode({ mode: 'project', chosenOff: false }, 2, false)).toBe('project');
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

  it('folders: in your order, empty ones too, then the rest', () => {
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
      ['Not in a folder', ['b', 'd']],
    ]);
    expect(got[0].groupId).toBe('g1');
    expect(got[2].groupId).toBeUndefined();
  });

  it('pinned agents sit above the folders, or first in their own', () => {
    const team = [agent('a'), agent('b', undefined, true), agent('c', undefined, true)];
    const settings = {
      mode: 'custom' as const,
      groups: [{ id: 'g1', name: 'SEO' }],
      assign: { a: 'g1', b: 'g1' },
    };
    const top = sectionAgents(team, { ...settings, pinned: 'top' }, name);
    expect(top.map((s) => [s.title, s.agents.map((a) => a.id)])).toEqual([
      ['Pinned', ['b', 'c']],
      ['SEO', ['a']],
      ['Not in a folder', []],
    ]);
    const inFolder = sectionAgents(team, { ...settings, pinned: 'inFolder' }, name);
    expect(inFolder.map((s) => [s.title, s.agents.map((a) => a.id)])).toEqual([
      ['SEO', ['b', 'a']],
      ['Not in a folder', ['c']],
    ]);
  });
});

describe('changing folders', () => {
  let calls: [string, unknown][] = [];
  beforeEach(() => {
    localStorage.clear();
    calls = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'agents_folder_create')
        return { id: 'f1', name: (args as { name: string }).name };
      return null;
    });
    syncFolders({ folders: [], pinned: 'top' }, []);
    // Nothing chosen: folders show once there are any.
    setGroupMode('custom');
  });

  it('makes a folder on the Mac, filing the agent it was opened for', async () => {
    startNamingGroup('scout');
    expect(getAgentGroups().mode).toBe('custom');
    const folder = await addGroup('  Acme  ');
    expect(folder?.id).toBe('f1');
    expect(calls).toContainEqual(['agents_folder_create', { name: 'Acme', agent: 'scout' }]);
    expect(getAgentGroups().assign).toEqual({ scout: 'f1' });
    expect(getAgentGroups().naming).toBeUndefined();
  });

  it('files, folds and removes, the folds kept across a reload', async () => {
    syncFolders({ folders: [{ id: 'f1', name: 'Acme' }], pinned: 'top' }, []);
    await moveToGroup('scout', 'f1');
    expect(calls).toContainEqual(['agents_set_folder', { agentId: 'scout', folder: 'f1' }]);
    toggleCollapsed('group:f1');
    expect(parseLocal(localStorage.getItem('shipstudio.agents.groups')).collapsed).toEqual([
      'group:f1',
    ]);
    await removeGroup('f1');
    expect(calls).toContainEqual(['agents_folder_delete', { id: 'f1' }]);
    expect(getAgentGroups().assign).toEqual({});
    expect(getAgentGroups().collapsed).toEqual([]);
  });

  it('takes who is in which folder from the agents', () => {
    syncFolders({ folders: [{ id: 'f1', name: 'SEO' }], pinned: 'inFolder' }, [
      { ...agent('a'), folder: 'f1' } as Agent,
      agent('b'),
    ]);
    expect(getAgentGroups().assign).toEqual({ a: 'f1' });
    expect(getAgentGroups().pinned).toBe('inFolder');
    expect(getAgentGroups().mode).toBe('custom');
  });

  it('reorders folders at once and sends the new order to the Mac', async () => {
    const three = ['f1', 'f2', 'f3'].map((id) => ({ id, name: id.toUpperCase() }));
    syncFolders({ folders: three, pinned: 'top' }, []);
    await moveGroup('f3', 'f1', false);
    expect(getAgentGroups().groups.map((g) => g.id)).toEqual(['f3', 'f1', 'f2']);
    expect(calls).toContainEqual(['agents_folders_reorder', { ids: ['f3', 'f1', 'f2'] }]);
    await moveGroup('f3', 'f2', true);
    expect(getAgentGroups().groups.map((g) => g.id)).toEqual(['f1', 'f2', 'f3']);
  });

  it('never names a folder with nothing', async () => {
    expect(await addGroup('   ')).toBeNull();
    expect(calls.some(([cmd]) => cmd === 'agents_folder_create')).toBe(false);
  });

  it('brings a window’s old groups to the Mac once', async () => {
    localStorage.setItem(
      'shipstudio.agents.groups',
      JSON.stringify({ mode: 'custom', groups: [{ id: 'g1', name: 'Acme' }], assign: { a: 'g1' } })
    );
    vi.resetModules();
    const fresh = await import('./agentGroups');
    fresh.syncFolders({ folders: [], pinned: 'top' }, []);
    await vi.waitFor(() =>
      expect(calls).toContainEqual([
        'agents_folders_bring_in',
        { groups: [{ id: 'g1', name: 'Acme' }], assign: { a: 'g1' } },
      ])
    );
    await vi.waitFor(() =>
      expect(parseLocal(localStorage.getItem('shipstudio.agents.groups')).legacyGroups).toEqual([])
    );
    // Brought in already (by this window or another): never asked again.
    calls = [];
    fresh.syncFolders(
      { folders: [{ id: 'g1', name: 'Acme' }], pinned: 'top', broughtIn: true },
      []
    );
    expect(calls.some(([cmd]) => cmd === 'agents_folders_bring_in')).toBe(false);
  });
});

describe('your own order', () => {
  it('moves a row before or after another', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorder(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(reorder(['a', 'b'], 'a', null)).toEqual(['b', 'a']);
  });

  it('keeps your order and puts agents new since then at the end', () => {
    const items = ['x', 'a', 'b', 'c'].map((id) => ({ id }));
    expect(inYourOrder(items, ['c', 'a', 'gone']).map((i) => i.id)).toEqual(['c', 'a', 'x', 'b']);
  });

  it('reads a saved order, and falls back to activity without one', () => {
    expect(parseLocal(JSON.stringify({ sort: 'yours', order: ['a'] })).sort).toBe('yours');
    expect(parseLocal(JSON.stringify({ sort: 'yours', order: [] })).sort).toBe('activity');
    expect(parseLocal(null).sort).toBe('activity');
  });
});
