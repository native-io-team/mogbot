/**
 * The agent as its typing key (components/AgentKey.tsx): the box is the
 * spec's (the avatar's size, the travel under it), the face is the agent's
 * own, and only while it's live (and allowed to move) does the clock run; at
 * rest the top sits at rest.
 */

import { TYPING_KEY } from '@shipstudio/companion-protocol';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { AgentKey } from '../src/components/AgentKey';

const mockMoving = jest.fn((still: boolean) => !still);
const mockRepeat = jest.fn((to: number) => to);
jest.mock('react-native-reanimated', () =>
  require('./reanimatedStub').reanimated({
    withRepeat: (anim: number) => mockRepeat(anim),
    Easing: { linear: (t: number) => t },
  })
);
jest.mock('../src/lib/moving', () => ({ useMoving: (still: boolean) => mockMoving(still) }));
jest.mock('../src/components/agent', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    useLook: () => ({ shape: 'hexagon', face: 'smile', finish: 'embossed' }),
    RimFilter: () => null,
    Face: (p: { px: number; selected: boolean; look: { face: string } }) => (
      <View testID="face" accessibilityLabel={`${p.look.face}:${p.px}:${p.selected}`} />
    ),
  };
});

// The key is hidden from accessibility (the line speaks for it).
const hidden = { includeHiddenElements: true };

beforeEach(() => mockRepeat.mockClear());

describe('the typing key', () => {
  it('is the avatar itself, the spec’s size, with its side under it', async () => {
    await render(<AgentKey id="qa" name="QA" color="green" pressing />);
    expect(StyleSheet.flatten(screen.getByTestId('agent-key', hidden).props.style)).toMatchObject({
      width: TYPING_KEY.size,
      height: TYPING_KEY.size + TYPING_KEY.travel,
    });
    // Its own face, drawn at the key's size, not the solid "selected" one.
    expect(screen.getByTestId('face', hidden).props.accessibilityLabel).toBe(
      `smile:${TYPING_KEY.size}:false`
    );
    expect(mockRepeat).toHaveBeenCalled();
  });

  it('rests while it isn’t being typed on', async () => {
    await render(<AgentKey id="qa" name="QA" color="green" pressing={false} />);
    expect(mockRepeat).not.toHaveBeenCalled();
    const top = StyleSheet.flatten(screen.getByTestId('agent-key-top', hidden).props.style);
    expect(top.transform).toEqual([{ translateY: 0 }]);
  });
});
