/**
 * An agent's key on the phone (components/AgentKey.tsx; the spec is
 * docs/internal/agent-keys.md): the desk's geometry, its colourway and
 * legend from the registry, the six physical states, the sublegend and pips
 * on big keys only, and the one animation, the Needs-your-OK pulse, running
 * only on that state and only while things may move.
 */

import { KEY_GEOMETRY, KEY_STATES, type AgentsOverview } from '@shipstudio/companion-protocol';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { AgentKey } from '../src/components/AgentKey';
import { keyGeometry, keyPose } from '../src/lib/agentKey';
import { setApp } from '../src/lib/store';
import { keyColorways, keySize } from '../src/lib/theme';
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
        const p = keyPose(g, state, false);
        expect(p.down + p.depth).toBeCloseTo(g.rest, 9);
      }
    }
  });

  it('presses while it works, sits proud while it needs your OK, darker lit on a pale face', () => {
    const g = keyGeometry(keySize.xl);
    expect(keyPose(g, 'working', false)).toMatchObject({ down: 6, depth: 2, shade: 0.08 });
    expect(keyPose(g, 'needsOk', false)).toMatchObject({ down: -5, depth: 13, lit: true });
    expect(keyPose(g, 'live', false).shade).toBe(KEY_GEOMETRY.live.darken);
    expect(keyPose(g, 'live', true).shade).toBe(KEY_GEOMETRY.live.darkenLight);
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

  it('is pressed while it works, its face washed darker', async () => {
    await render(<AgentKey name="Ops" state="working" size={keySize.xl} />);
    expect(style('agent-key-cap-working').top).toBe(6);
    expect(style('agent-key-shade').opacity).toBe(0.08);
    expect(screen.getByTestId('agent-key-legend', hidden)).toBeTruthy();
  });

  it('is lit while it’s live, and does not pulse', async () => {
    await render(<AgentKey name="Ops" state="live" size={keySize.xl} />);
    expect(screen.getByTestId('agent-key-legend-lit', hidden)).toBeTruthy();
    expect(screen.queryByTestId('agent-key-pulse', hidden)).toBeNull();
    expect(mockRepeat).not.toHaveBeenCalled();
  });

  it('pulses only while it needs your OK', async () => {
    await render(<AgentKey name="Ops" state="needsOk" size={keySize.xl} />);
    expect(screen.getByTestId('agent-key-pulse', hidden)).toBeTruthy();
    expect(screen.getByTestId('agent-key-legend-lit', hidden)).toBeTruthy();
    expect(style('agent-key-cap-needsOk').top).toBe(-5);
    expect(mockRepeat).toHaveBeenCalledTimes(1);
  });

  it('holds still with Reduce Motion (or off screen): lit, no pulse running', async () => {
    mockMoving.mockImplementation(() => false);
    await render(<AgentKey name="Ops" state="needsOk" size={keySize.xl} />);
    expect(screen.getByTestId('agent-key-legend-lit', hidden)).toBeTruthy();
    expect(mockRepeat).not.toHaveBeenCalled();
    expect(style('agent-key-pulse').opacity).toBe(1);
  });

  it('runs nothing at rest: no pulse, no clock', async () => {
    await render(<AgentKey name="Ops" size={keySize.xl} />);
    expect(mockMoving).not.toHaveBeenCalled();
    expect(mockRepeat).not.toHaveBeenCalled();
  });

  it('is a socket with its stem in its colour when paused', async () => {
    await render(<AgentKey name="Ops" colorway="orange" state="paused" size={keySize.xl} />);
    expect(screen.getByTestId('agent-key-socket-paused', hidden)).toBeTruthy();
    expect(screen.queryByTestId('agent-key-depth', hidden)).toBeNull();
  });

  it('is an outlined plus for a new agent, never a socket', async () => {
    await render(<AgentKey state="new" size={keySize.xl} />);
    expect(screen.getByTestId('agent-key-new', hidden)).toBeTruthy();
    expect(screen.queryByTestId('agent-key-socket-new', hidden)).toBeNull();
    expect(screen.queryByTestId('agent-key-stem', hidden)).toBeNull();
  });
});
