/**
 * A file an agent shares with its text (`share_file` `text`): the phone
 * shows the whole text, as a normal reply, above the image. Asked for
 * "full text then image, post by post", an agent once sent only labels;
 * the text it now sends must reach the phone uncut.
 */

import type { AgentMessage } from '@shipstudio/companion-protocol';
import { render, screen } from '@testing-library/react-native';
import { agent, msg } from './helpers';

jest.mock('react-native-reanimated', () => {
  const { View, FlatList } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: { View, FlatList },
    FadeIn: preset,
    FadeInDown: preset,
    FadeOut: preset,
    ZoomIn: preset,
    ZoomOut: preset,
    LinearTransition: preset,
    useReducedMotion: () => true,
    useSharedValue: (v: unknown) => ({ value: v, set: () => {} }),
    useAnimatedStyle: () => ({}),
    withSequence: () => 0,
    withTiming: () => 0,
    Easing: { out: () => 0, inOut: () => 0, quad: 0 },
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-haptics', () => ({}));
jest.mock('expo-image', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Image: (props: { source: { uri: string } }) => <View testID={`img:${props.source.uri}`} />,
  };
});
jest.mock('../src/lib/haptics', () => ({
  haptic: {
    light: jest.fn(),
    select: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('../src/lib/session', () => ({
  attachmentSource: (_agentId: string, path: string) => ({ uri: `https://mac.example/${path}` }),
  answerApproval: jest.fn(),
  describeError: String,
  download: jest.fn(),
  send: jest.fn(),
}));

import { MessageRow } from '../src/components/chat';

/** Every text and image in the row, in the order they're drawn. */
interface Node {
  type: unknown;
  props: Record<string, unknown>;
  children: (Node | string)[];
}
function drawn(root: Node | null): string[] {
  const out: string[] = [];
  const walk = (node: Node) => {
    const id = node.props?.testID as string | undefined;
    if (id?.startsWith('img:')) out.push(id);
    for (const child of node.children) {
      if (typeof child === 'string') out.push(child);
      else walk(child);
    }
  };
  if (root) walk(root);
  return out;
}

describe('a shared file with its text', () => {
  const post =
    'Fresh sourdough, out of the oven at 7 every morning this week. Come early: the first ' +
    'loaves always go by 8, and the seeded rye goes even faster than that.';
  const message: AgentMessage = msg('p1', 1, {
    agentId: 'social',
    text: `1 of 6 · Fri 10am\n\n${post}`,
    attachments: [
      { name: 'post-1.png', path: 'attachments/p1/post-1.png', mime: 'image/png', size: 10 },
    ],
  });

  it('shows the whole text, uncut, above the image', async () => {
    const view = await render(
      <MessageRow message={message} agent={agent()} queued={false} onError={() => {}} />
    );
    const order = drawn(view.toJSON() as Node | null);
    const text = order.findIndex((s) => s.includes('seeded rye goes even faster'));
    const image = order.indexOf('img:https://mac.example/attachments/p1/post-1.png');
    expect(text).toBeGreaterThanOrEqual(0);
    expect(image).toBeGreaterThan(text);
    expect(order.join('')).toContain(post);
    expect(screen.getByText(/1 of 6 · Fri 10am/)).toBeTruthy();
  });
});
