/**
 * The avatar's blink on the phone (components/agent.tsx, AgentKey.tsx;
 * lib/avatarBlink.ts): the eyes get a layer of their own, a random schedule
 * from the spec runs only while the avatar may move, and tiny avatars, faces
 * without eyes and `still` ones don't blink.
 */

import { BLINK } from '@shipstudio/companion-protocol';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { AgentAvatar } from '../src/components/agent';
import { blinkAnimation } from '../src/lib/avatarBlink';
import { eyeScaleY } from '../src/lib/eyeBlink';

const mockMoving = jest.fn((still: boolean) => !still);
const mockRepeat = jest.fn((to: unknown) => to);
const mockDelay = jest.fn((ms: number, to: unknown) => ({ ms, to }));
const mockTiming = jest.fn((to: number) => to);
const mockSequence = jest.fn((...steps: unknown[]) => steps);
jest.mock('react-native-reanimated', () =>
  require('./reanimatedStub').reanimated({
    withRepeat: (a: unknown) => mockRepeat(a),
    withDelay: (ms: number, a: unknown) => mockDelay(ms, a),
    withTiming: (to: number) => mockTiming(to),
    withSequence: (...s: unknown[]) => mockSequence(...s),
    Easing: { inOut: () => (t: number) => t, linear: (t: number) => t, quad: (t: number) => t },
  })
);
jest.mock('../src/lib/moving', () => ({ useMoving: (still: boolean) => mockMoving(still) }));

const hidden = { includeHiddenElements: true };
const eyes = () => screen.queryByTestId('agent-eyes', hidden);

beforeEach(() => {
  mockRepeat.mockClear();
  mockDelay.mockClear();
  mockMoving.mockImplementation((still: boolean) => !still);
});

describe('the eyes', () => {
  it('shut to the spec’s thin line and open again', () => {
    expect(eyeScaleY(0)).toBe(1);
    expect(eyeScaleY(1)).toBeCloseTo(BLINK.closedScale);
    expect(eyeScaleY(-1)).toBe(1);
    expect(eyeScaleY(2)).toBeCloseTo(BLINK.closedScale);
  });

  it('blink on a schedule of 3 to 7 second waits, its own to each avatar', () => {
    mockDelay.mockClear();
    blinkAnimation(() => 0, 4);
    blinkAnimation(() => 0.999, 4);
    const waits = mockDelay.mock.calls.map((c) => c[0]);
    // The double blink adds a short wait inside; the gaps are the long ones.
    const gaps = waits.filter((w) => w >= BLINK.gapMs[0]);
    expect(Math.min(...gaps)).toBe(BLINK.gapMs[0]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(BLINK.gapMs[1]);
    expect(mockRepeat).toHaveBeenCalledTimes(2);
  });
});

describe('a blinking avatar', () => {
  it('draws its eyes on their own layer and runs the schedule', async () => {
    await render(<AgentAvatar name="QA" color="green" id="qa" size={28} />);
    expect(eyes()).not.toBeNull();
    expect(mockRepeat).toHaveBeenCalled();
    const style = StyleSheet.flatten(eyes()!.props.style);
    expect(style.transform.map((t: object) => Object.keys(t)[0])).toEqual([
      'translateY',
      'scaleY',
      'translateY',
    ]);
  });

  it('holds its eyes open when it may not move (Reduce Motion, background, off screen)', async () => {
    mockMoving.mockImplementation(() => false);
    await render(<AgentAvatar name="QA" color="green" id="qa" size={28} />);
    expect(mockRepeat).not.toHaveBeenCalled();
    const style = StyleSheet.flatten(eyes()!.props.style);
    expect(style.transform[1]).toEqual({ scaleY: 1 });
  });

  it('does not blink when tiny, when still, or with no eyes', async () => {
    const { unmount } = await render(<AgentAvatar name="QA" color="green" id="qa" size={16} />);
    expect(eyes()).toBeNull();
    unmount();
    const b = await render(<AgentAvatar name="QA" color="green" id="qa" size={28} still />);
    expect(eyes()).toBeNull();
    b.unmount();
    await render(
      <AgentAvatar name="QA" color="green" size={28} look={{ shape: 'circle', face: 'monogram' }} />
    );
    expect(eyes()).toBeNull();
  });
});
