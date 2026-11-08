/**
 * The agent on its typing key (components/AgentKey.tsx): the key's box is
 * the spec's, the avatar on it is the solid one, and only while it's live
 * (and allowed to move) does the clock run; at rest the top sits at rest.
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
    AgentAvatar: (p: { selected?: boolean; mood?: string; size?: number }) => (
      <View testID="avatar" accessibilityLabel={`${p.selected}:${p.mood}:${p.size}`} />
    ),
  };
});

beforeEach(() => mockRepeat.mockClear());

describe('the typing key', () => {
  it('is the spec’s box, with the solid avatar on it', async () => {
    await render(<AgentKey id="qa" name="QA" color="green" pressing />);
    expect(StyleSheet.flatten(screen.getByTestId('agent-key').props.style)).toMatchObject({
      width: TYPING_KEY.width,
      height: TYPING_KEY.top + TYPING_KEY.travel,
    });
    expect(screen.getByTestId('avatar').props.accessibilityLabel).toBe(
      `true:working:${TYPING_KEY.avatar}`
    );
    expect(mockRepeat).toHaveBeenCalled();
  });

  it('rests while it isn’t being typed on', async () => {
    await render(<AgentKey id="qa" name="QA" color="green" pressing={false} />);
    expect(screen.getByTestId('avatar').props.accessibilityLabel).toBe(
      `true:idle:${TYPING_KEY.avatar}`
    );
    expect(mockRepeat).not.toHaveBeenCalled();
  });
});
