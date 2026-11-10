/**
 * An agent's key on the phone (components/AgentKey.tsx; the spec is
 * docs/internal/agent-keys.md): the desk's geometry, its colourway and
 * legend from the registry, the six physical states, the sublegend and pips
 * on big keys only, and the two loops (a working key's breath, the
 * Needs-your-OK pulse), each only on its state and only while things may move.
 */

import { KEY_GEOMETRY, KEY_STATES, type AgentsOverview } from '@shipstudio/companion-protocol';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { AgentKey } from '../src/components/AgentKey';
import { askKeyline, keyGeometry, keyPaint, keyPose } from '../src/lib/agentKey';
import { setApp } from '../src/lib/store';
import { contrast, keyColorways, keyLit, keySize, luminance } from '../src/lib/theme';
import { agent } from './helpers';

const mockMoving = jest.fn((still: boolean) => !still);
const mockRepeat = jest.fn((to: number) => to);
jest.mock('react-native-reanimated', () =>
  require('./reanimatedStub').reanimated({
    withRepeat: (anim: number) => mockRepeat(anim),
    Easing: { inOut: () => (t: number) => t, quad: (t: number) => t },
  })
);
jest.mock('../src/lib/moving', () => ({ useMoving: (still: boolean) => mockMoving(still) }));

// The key is hidden from accessibility (the row or the line speaks for it).
const hidden = { includeHiddenElements: true };
const style = (id: string) =>
  StyleSheet.flatten(screen.getByTestId(id, hidden).props.style) as Record<string, unknown>;

/** The legend's drawn paths, as react-native-svg hands them to the native side. */
type Node = { type: string; props: Record<string, unknown>; children?: Node[] | null };
type Paint = { payload: number } | null;
const paths = (): { fill: Paint; stroke: Paint; fillRule: unknown }[] => {
  const out: { fill: Paint; stroke: Paint; fillRule: unknown }[] = [];
  const walk = (n: Node | Node[] | null) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'RNSVGPath') out.push(n.props as never);
    (n.children ?? []).forEach((c) => typeof c === 'object' && walk(c));
  };
  walk(screen.toJSON() as Node | Node[] | null);
  return out;
};
// react-native-svg's processed colour: 0xAARRGGBB.
const argb = (hex: string) => 0xff000000 + parseInt(hex.slice(1), 16);

beforeEach(() => {
  mockRepeat.mockClear();
  mockMoving.mockClear();
  mockMoving.mockImplementation((still: boolean) => !still);
  setApp({ overview: null });
});

describe('the geometry', () => {
  it('is the desk’s at 112: radius 16, face inset 10/5/17 at 11, depth 8, icon 40', () => {
    const g = keyGeometry(keySize.xl);
    expect(g).toMatchObject({
      corner: 16,
      insetX: 10,
      insetTop: 5,
      insetBottom: 17,
      faceCorner: 11,
      rest: 8,
      icon: 40,
      details: true,
    });
  });

  it('draws the small key on its own 30pt unit: depth 3, icon 15, nothing on the edge', () => {
    const g = keyGeometry(keySize.md);
    expect(g).toMatchObject({ rest: 3, icon: 15, insetX: 3, insetBottom: 5, details: false });
    expect(keyGeometry(keySize.lg).details).toBe(false);
  });

  it('never moves what’s beside it: down plus depth is the rest depth in every state', () => {
    for (const size of Object.values(keySize)) {
      const g = keyGeometry(size);
      for (const state of KEY_STATES) {
        const p = keyPose(g, state);
        expect(p.down + p.depth).toBeCloseTo(g.rest, 9);
      }
    }
  });

  it('presses and lights while it works, sits proud and amber while it needs your OK', () => {
    const g = keyGeometry(keySize.xl);
    expect(keyPose(g, 'working')).toMatchObject({ down: 6.5, depth: 1.5, light: 'warm' });
    expect(keyPose(g, 'needsOk')).toMatchObject({ down: -5, depth: 13, light: 'ask' });
    expect(keyPose(g, 'live')).toMatchObject({ down: 0, light: 'warm' });
    expect(keyPose(g, 'paused')).toMatchObject({ down: 4, depth: 4, light: 'none' });
    expect(keyPose(g, 'idle', true)).toMatchObject({ down: 6.5, depth: 1.5 });
  });

  it('deepens a lit face in its own hue, more on a pale one, and drains a paused one', () => {
    const blue = keyPaint('blue', keyColorways.blue, 'working');
    expect(blue.face).not.toBe(keyColorways.blue.face);
    expect(blue.legend.toLowerCase()).toBe(KEY_GEOMETRY.live.legend.toLowerCase());
    const ask = keyPaint('blue', keyColorways.blue, 'needsOk');
    expect(ask.legend.toLowerCase()).toBe(KEY_GEOMETRY.needsOk.legend.toLowerCase());
    expect(luminance(ask.face)).toBeLessThan(luminance(blue.face));
    const paused = keyPaint('orange', keyColorways.orange, 'paused');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(paused.face.slice(i, i + 2), 16));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(40);
  });

  it('puts the sublegend clear of the face’s corner, as far from the right as the bottom', () => {
    const g = keyGeometry(keySize.xl);
    expect(g.sub.right).toBeGreaterThan(g.faceCorner * 0.75);
    expect(Math.abs(g.sub.right - g.sub.bottom)).toBeLessThanOrEqual(1);
  });
});

describe('the key', () => {
  it('stands on its depth: the box is the key and its depth under it', async () => {
    await render(<AgentKey name="Finance" size={keySize.lg} />);
    const g = keyGeometry(keySize.lg);
    expect(style('agent-key')).toMatchObject({ width: keySize.lg, height: keySize.lg + g.rest });
  });

  it('takes its colourway and legend from the registry', async () => {
    setApp({
      overview: {
        agents: [
          agent({ id: 'fin', name: 'Finance', colorway: 'teal', icon: 'chat', boundKey: 'F' }),
        ],
      } as unknown as AgentsOverview,
    });
    await render(<AgentKey id="fin" name="Finance" size={keySize.xl} />);
    expect(style('agent-key-cap-idle').backgroundColor).toBe(keyColorways.teal.skirt);
    expect(style('agent-key-depth').backgroundColor).toBe(keyColorways.teal.depth);
    expect(screen.getByTestId('agent-key-sub', hidden).props.children).toBe('F');
  });

  it('falls back to the old colour and its name on an older Mac', async () => {
    await render(<AgentKey name="Finance" color="amber" size={keySize.md} />);
    expect(style('agent-key-cap-idle').backgroundColor).toBe(keyColorways.mustard.skirt);
  });

  it('fills the app’s mark, the Chief’s legend, in its ink', async () => {
    await render(<AgentKey name="Chief" icon="mogbot" colorway="graphite" size={keySize.xl} />);
    // One path (the dome, its eyes cut out even-odd), filled, unstroked.
    const [mark, ...more] = paths();
    expect(more).toHaveLength(0);
    expect(mark.fill?.payload).toBe(argb(keyColorways.graphite.legend));
    expect(mark.fillRule).toBe(0);
    expect(mark.stroke).toBeNull();
  });

  it('lit, glow rings outline the app’s mark under its fill', async () => {
    await render(
      <AgentKey name="Chief" icon="mogbot" colorway="graphite" state="working" size={keySize.xl} />
    );
    const lit = paths();
    expect(lit).toHaveLength(3);
    expect(lit.slice(0, 2).every((p) => p.fill === null && p.stroke !== null)).toBe(true);
    expect(lit[2].fill).not.toBeNull();
    expect(lit[2].stroke).toBeNull();
  });

  it('goes all the way down while a finger is on it', async () => {
    await render(<AgentKey name="Ops" pressed size={keySize.xl} />);
    expect(style('agent-key-cap-idle').top).toBe(6.5);
  });

  it('shows the sublegend and the pips on a big key only', async () => {
    await render(<AgentKey name="Ops" boundKey="O" level="go_hard" size={keySize.xl} />);
    expect(screen.getAllByTestId('agent-key-pip-on', hidden)).toHaveLength(3);
    expect(screen.getAllByTestId('agent-key-pip', hidden)).toHaveLength(1);
    expect(screen.getByTestId('agent-key-sub', hidden).props.children).toBe('O');
  });

  it('leaves them off a small key', async () => {
    await render(<AgentKey name="Ops" boundKey="O" level="go_hard" size={keySize.md} />);
    expect(screen.queryByTestId('agent-key-sub', hidden)).toBeNull();
    expect(screen.queryAllByTestId('agent-key-pip-on', hidden)).toHaveLength(0);
  });

  it('is pressed, lit and breathing while it works, its light spilling under it', async () => {
    await render(<AgentKey name="Ops" state="working" size={keySize.xl} />);
    expect(style('agent-key-cap-working').top).toBe(6.5);
    expect(screen.getByTestId('agent-key-legend-lit', hidden)).toBeTruthy();
    expect(screen.getByTestId('agent-key-spill', hidden)).toBeTruthy();
    expect(screen.getAllByTestId('agent-key-breath', hidden).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('agent-key-pulse', hidden)).toBeNull();
  });

  it('is lit while it’s live, and holds still', async () => {
    await render(<AgentKey name="Ops" state="live" size={keySize.xl} />);
    expect(screen.getByTestId('agent-key-legend-lit', hidden)).toBeTruthy();
    expect(screen.getByTestId('agent-key-spill', hidden)).toBeTruthy();
    expect(screen.queryByTestId('agent-key-pulse', hidden)).toBeNull();
    expect(mockRepeat).not.toHaveBeenCalled();
  });

  it('pulses amber, proud, only while it needs your OK', async () => {
    await render(<AgentKey name="Ops" state="needsOk" size={keySize.xl} />);
    expect(screen.getAllByTestId('agent-key-pulse', hidden).length).toBeGreaterThan(0);
    expect(screen.getByTestId('agent-key-legend-ask', hidden)).toBeTruthy();
    expect(style('agent-key-cap-needsOk').top).toBe(-5);
    expect(mockRepeat).toHaveBeenCalled();
  });

  it('keeps a small Needs-your-OK legend sharp: steady, the spill still pulsing, no dark ring', async () => {
    await render(
      <AgentKey name="Finance" icon="money" colorway="plum" state="needsOk" size={keySize.md} />
    );
    // One pulse, the spill's; the legend holds still so it never fades on the face.
    expect(screen.getAllByTestId('agent-key-pulse', hidden)).toHaveLength(1);
    expect(screen.getByTestId('agent-key-legend-ask', hidden)).toBeTruthy();
    const strokes = paths().map((p) => p.stroke?.payload);
    expect(strokes).toContain(argb(keyLit.ask));
    // A dark face's legend is drawn bare: one colour of stroke, the amber.
    expect(new Set(strokes)).toEqual(new Set([argb(keyLit.ask)]));
    // No amber glow ring on the icon.
    expect(strokes).not.toContain(argb(keyLit.askGlow));
  });

  it('shades a pale face’s amber legend in the cap’s own depth colour, never black', async () => {
    await render(
      <AgentKey name="Finance" icon="money" colorway="putty" state="needsOk" size={keySize.md} />
    );
    const strokes = paths().map((p) => p.stroke?.payload);
    expect(strokes).toContain(argb(keyColorways.putty.depth));
    expect(strokes).toContain(argb(keyLit.ask));
  });

  it('draws the amber bare only where it parts from the lit face on its own', () => {
    for (const [id, paint] of Object.entries(keyColorways)) {
      const line = askKeyline(id, paint);
      if (line) {
        expect(line).toBe(paint.depth);
        continue;
      }
      // Orange sits just under 3:1 by luminance and parts by hue (amber on red-orange).
      const face = keyPaint(id, paint, 'needsOk').face;
      expect({ id, ok: contrast(keyLit.ask, face) >= 2.8 }).toEqual({ id, ok: true });
    }
  });

  it('holds still with Reduce Motion (or off screen): lit and amber, no pulse running', async () => {
    mockMoving.mockImplementation(() => false);
    await render(<AgentKey name="Ops" state="needsOk" size={keySize.xl} />);
    expect(screen.getByTestId('agent-key-legend-ask', hidden)).toBeTruthy();
    expect(mockRepeat).not.toHaveBeenCalled();
    for (const p of screen.getAllByTestId('agent-key-pulse', hidden)) {
      expect(StyleSheet.flatten(p.props.style).opacity).toBe(1);
    }
  });

  it('runs nothing at rest: no pulse, no clock', async () => {
    await render(<AgentKey name="Ops" size={keySize.xl} />);
    expect(mockMoving).not.toHaveBeenCalled();
    expect(mockRepeat).not.toHaveBeenCalled();
  });

  it('keeps its cap when paused, drained of colour and sunk halfway', async () => {
    await render(<AgentKey name="Ops" colorway="orange" state="paused" size={keySize.xl} />);
    expect(style('agent-key-cap-paused').top).toBe(4);
    expect(style('agent-key-cap-paused').backgroundColor).not.toBe(keyColorways.orange.skirt);
    expect(screen.queryByTestId('agent-key-socket-new', hidden)).toBeNull();
  });

  it('is the site’s empty socket for a new agent: a neutral stem, no cap', async () => {
    await render(<AgentKey state="new" size={keySize.xl} />);
    expect(screen.getByTestId('agent-key-socket-new', hidden)).toBeTruthy();
    expect(screen.getByTestId('agent-key-stem', hidden)).toBeTruthy();
    expect(screen.queryByTestId('agent-key-depth', hidden)).toBeNull();
  });
});
