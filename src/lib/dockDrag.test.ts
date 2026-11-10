import { describe, expect, it } from 'vitest';
import { applyDrop, describeDrop, dropTargetAt, railBoundaries } from './dockDrag';
import { PANEL_META, PREVIEW, isFloating, type WorkspaceLayout } from './workspaceLayout';

const geometry = {
  bounds: { left: 0, right: 1200, top: 100, bottom: 800 },
  columns: [
    { columnIndex: 0, left: 0, right: 300, top: 100, bottom: 800 },
    { columnIndex: 1, left: 300, right: 900, top: 100, bottom: 800, preview: true },
    { columnIndex: 2, left: 900, right: 1200, top: 100, bottom: 800 },
  ],
  panels: [
    {
      panel: 'agent' as const,
      columnIndex: 0,
      panelIndex: 0,
      left: 0,
      right: 300,
      top: 100,
      bottom: 800,
    },
    {
      panel: 'editor' as const,
      columnIndex: 2,
      panelIndex: 0,
      left: 900,
      right: 1200,
      top: 100,
      bottom: 800,
    },
  ],
};

const layout: WorkspaceLayout = {
  version: 2,
  columns: [
    { kind: 'panels', panels: [{ panel: 'agent', weight: 1 }] },
    { kind: 'preview' },
    { kind: 'panels', panels: [{ panel: 'editor', weight: 1 }] },
    { kind: 'panels', panels: [{ panel: 'navigator', weight: 1 }] },
  ],
  floating: [],
};

describe('railBoundaries', () => {
  it('offers one seam per column join plus the two ends', () => {
    expect(railBoundaries(geometry.columns, geometry.bounds)).toEqual([
      { x: 0, beforeColumn: 0 },
      { x: 300, beforeColumn: 1 },
      { x: 900, beforeColumn: 2 },
      { x: 1200, beforeColumn: null },
    ]);
  });
});

describe('dropTargetAt', () => {
  it('creates a singleton column at a vertical seam', () => {
    expect(dropTargetAt(geometry, { x: 304, y: 400 })).toMatchObject({
      kind: 'column',
      beforeColumn: 1,
      x: 300,
    });
  });

  it('inserts above or below a panel inside a column', () => {
    const stacked = {
      ...geometry,
      columns: [
        { columnIndex: 0, left: 0, right: 300, top: 100, bottom: 800 },
        ...geometry.columns.slice(1),
      ],
      panels: [
        {
          panel: 'agent' as const,
          columnIndex: 0,
          panelIndex: 0,
          left: 0,
          right: 300,
          top: 100,
          bottom: 400,
        },
        {
          panel: 'navigator' as const,
          columnIndex: 0,
          panelIndex: 1,
          left: 0,
          right: 300,
          top: 400,
          bottom: 800,
        },
        ...geometry.panels.slice(1),
      ],
    };
    expect(dropTargetAt(stacked, { x: 150, y: 110 })).toMatchObject({
      kind: 'stack',
      columnIndex: 0,
      beforePanel: 'agent',
    });
    expect(dropTargetAt(stacked, { x: 150, y: 790 })).toMatchObject({
      kind: 'stack',
      columnIndex: 0,
      beforePanel: null,
      afterPanel: 'navigator',
    });
  });

  it('floats over the panel body outside the narrow stack boundaries', () => {
    const stacked = {
      ...geometry,
      columns: [
        { columnIndex: 0, left: 0, right: 300, top: 100, bottom: 800 },
        ...geometry.columns.slice(1),
      ],
      panels: [
        {
          panel: 'agent' as const,
          columnIndex: 0,
          panelIndex: 0,
          left: 0,
          right: 300,
          top: 100,
          bottom: 400,
        },
        {
          panel: 'navigator' as const,
          columnIndex: 0,
          panelIndex: 1,
          left: 0,
          right: 300,
          top: 400,
          bottom: 800,
        },
        ...geometry.panels.slice(1),
      ],
    };

    expect(dropTargetAt(stacked, { x: 150, y: 250 })).toEqual({ kind: 'float' });
    expect(dropTargetAt(stacked, { x: 150, y: 650 })).toEqual({ kind: 'float' });
  });

  it('never stacks over the preview and floats away from the rail', () => {
    expect(dropTargetAt(geometry, { x: 600, y: 400 })).toEqual({ kind: 'float' });
    expect(dropTargetAt(geometry, { x: 600, y: 40 })).toEqual({ kind: 'float' });
  });
});

describe('applyDrop', () => {
  it('moves a panel into a new horizontal column', () => {
    const result = applyDrop(layout, 'agent', {
      kind: 'column',
      beforeColumn: 2,
      x: 900,
      top: 100,
      bottom: 800,
    });
    expect(
      result.columns.map((column) => (column.kind === 'preview' ? PREVIEW : column.panels[0].panel))
    ).toEqual([PREVIEW, 'agent', 'editor', 'navigator']);
  });

  it('stacks before and after existing panels', () => {
    const stacked = {
      ...layout,
      columns: [
        { kind: 'panels' as const, panels: [{ panel: 'agent' as const, weight: 1 }] },
        { kind: 'panels' as const, panels: [{ panel: 'navigator' as const, weight: 1 }] },
        ...layout.columns.slice(1),
      ],
    };
    const result = applyDrop(stacked, 'editor', {
      kind: 'stack',
      columnIndex: 0,
      beforePanel: 'agent',
      afterPanel: null,
      left: 0,
      right: 300,
      y: 100,
      top: 100,
      bottom: 800,
    });
    expect(result.columns[0]).toMatchObject({ panels: [{ panel: 'editor' }, { panel: 'agent' }] });
  });

  it('floats a panel while retaining its structural placement', () => {
    const result = applyDrop(layout, 'agent', { kind: 'float' });
    expect(isFloating(result, 'agent')).toBe(true);
    expect(result.columns[0]).toMatchObject({ panels: [{ panel: 'agent' }] });
  });
});

describe('describeDrop', () => {
  const labelOf = (panel: keyof typeof PANEL_META) => PANEL_META[panel].label;

  it('communicates the two axes explicitly', () => {
    expect(describeDrop({ kind: 'float' }, labelOf)).toBe('Float');
    expect(
      describeDrop({ kind: 'column', beforeColumn: 2, x: 0, top: 0, bottom: 1 }, labelOf)
    ).toBe('New column here');
    expect(
      describeDrop(
        {
          kind: 'stack',
          columnIndex: 0,
          beforePanel: 'agent',
          afterPanel: null,
          left: 0,
          right: 1,
          y: 0,
          top: 0,
          bottom: 1,
        },
        labelOf
      )
    ).toBe('Above Session · same column');
    expect(
      describeDrop(
        {
          kind: 'stack',
          columnIndex: 0,
          beforePanel: null,
          afterPanel: 'agent',
          left: 0,
          right: 1,
          y: 0,
          top: 0,
          bottom: 1,
        },
        labelOf
      )
    ).toBe('Below Session · same column');
  });
});
