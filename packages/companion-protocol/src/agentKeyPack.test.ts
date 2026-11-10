import { beforeAll, describe, expect, it } from 'vitest';
import cases from './agent-key-cases.json';
import data from './agent-keys.json';
import index from './agent-key-pack/index.json';
import { PACK_SHARDS } from './agentKeyPackShards';
import {
  PACK_PREFIX,
  isPackIconId,
  loadAllPackDrawings,
  packDrawingsVersion,
  packIconName,
  subscribePackDrawings,
  type PackIndex,
} from './agentKeyPack';
import { iconName, isKeyIcon, legendDrawing } from './agentKeys';
import { buildCatalog, searchIcons, FEATURED_CATEGORY } from './agentKeySearch';
import type { KeyIconDrawing } from './agentKeyIcons';

const pack = index as unknown as PackIndex;
/** Every drawing, by shard: what each loader brings. */
const byShard: Record<string, Record<string, KeyIconDrawing>> = {};
const allDrawings: Record<string, KeyIconDrawing> = {};

beforeAll(async () => {
  for (const [shard, load] of Object.entries(PACK_SHARDS)) {
    const m = (await load()) as { default: Record<string, KeyIconDrawing> };
    byShard[shard] = m.default;
    Object.assign(allDrawings, m.default);
  }
});

describe('the icon pack', () => {
  it('is what agent-keys.json says (the Mac checks the same count and the licence)', () => {
    expect(pack.icons.length).toBe(data.pack.count);
    expect(pack.version).toBe(data.pack.version);
    expect(PACK_PREFIX).toBe('lucide:');
  });

  it('has a drawing for every icon in the index, each in its first letter’s file', () => {
    expect(Object.keys(allDrawings).sort()).toEqual(pack.icons.map(([n]) => n).sort());
    for (const [shard, map] of Object.entries(byShard)) {
      for (const name of Object.keys(map)) expect(name[0], name).toBe(shard);
    }
    for (const [name, d] of Object.entries(allDrawings)) {
      expect(isPackIconId(PACK_PREFIX + name), name).toBe(true);
      expect(d.paths.length + (d.circles?.length ?? 0), name).toBeGreaterThan(0);
      // Strokes only: SVG path data and plain circles on the 24 grid.
      for (const p of d.paths) expect(p, name).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/);
      for (const [cx, cy, r] of d.circles ?? []) {
        expect(cx >= 0 && cx <= 24 && cy >= 0 && cy <= 24 && r > 0, name).toBe(true);
      }
    }
  });

  it('every category an icon names is real', () => {
    for (const [, , cats] of pack.icons) {
      for (const c of cats) expect(pack.categories[c]).toBeDefined();
    }
  });

  it('draws a pack icon once its file arrives, round-capped, and names it', async () => {
    expect(isKeyIcon('lucide:wallet')).toBe(true);
    expect(iconName('lucide:badge-dollar-sign')).toBe('Badge dollar sign');
    expect(packIconName('lucide:house')).toBe('House');
    const seen: number[] = [];
    const off = subscribePackDrawings(() => seen.push(packDrawingsVersion()));
    // Not loaded yet: nothing to draw (and the load has started).
    expect(legendDrawing('lucide:zap')).toBeNull();
    await loadAllPackDrawings();
    off();
    expect(seen.length).toBeGreaterThan(0);
    expect(legendDrawing('lucide:zap')).toMatchObject({ round: true });
    expect(legendDrawing('lucide:zap')?.paths).toEqual(allDrawings.zap.paths);
    // An id the pack doesn't have draws the default legend.
    expect(legendDrawing('lucide:not-an-icon')?.round).toBeUndefined();
    expect(legendDrawing('star')?.round).toBeUndefined();
    expect(legendDrawing('mogbot')).toMatchObject({ fill: true });
  });
});

describe('finding an icon', () => {
  const catalog = buildCatalog(pack);

  it('puts first what the Mac resolves a word to', () => {
    for (const c of cases.find) {
      expect(searchIcons(catalog, c.query)[0]?.id ?? null, c.query).toBe(c.icon);
    }
  });

  it('finds good keys for everyday words', () => {
    const top = (q: string, n = 8) =>
      searchIcons(catalog, q)
        .slice(0, n)
        .map((e) => e.id);
    expect(top('money')).toEqual(
      expect.arrayContaining(['money', 'lucide:banknote', 'lucide:wallet', 'lucide:coins'])
    );
    expect(top('invoice')).toContain('lucide:receipt');
    expect(top('mail')).toContain('lucide:mail');
    expect(top('car')).toEqual(expect.arrayContaining(['car', 'lucide:car']));
    expect(top('house')).toContain('lucide:house');
    expect(top('home')).toContain('lucide:house');
    expect(top('code')).toEqual(expect.arrayContaining(['code', 'lucide:code']));
    expect(top('calendar')).toEqual(expect.arrayContaining(['calendar', 'lucide:calendar']));
    // Every word must match: "credit card" isn't every card.
    expect(top('credit card', 3)).toEqual(expect.arrayContaining(['lucide:credit-card']));
    expect(searchIcons(catalog, 'zzqx')).toEqual([]);
  });

  it('with no words lists everything, featured first; a category narrows it', () => {
    const all = searchIcons(catalog, '  ');
    expect(all.length).toBe(data.icons.length + pack.icons.length);
    expect(all[0].id).toBe('mogbot');
    const featured = searchIcons(catalog, '', FEATURED_CATEGORY);
    expect(featured.map((e) => e.id)).toEqual(data.icons.map((i) => i.id));
    const finance = searchIcons(catalog, '', 'finance');
    expect(finance.map((e) => e.id)).toContain('lucide:wallet');
    expect(searchIcons(catalog, 'wallet', 'animals')).toEqual([]);
    expect(catalog.categories[0]).toEqual({ id: 'featured', title: 'Featured' });
  });
});
