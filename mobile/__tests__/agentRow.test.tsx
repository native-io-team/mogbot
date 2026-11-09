/**
 * The agent row on Home, as a tap meets it: one press opens the chat once,
 * and the row stays the same element while the link and the Mac's welcome
 * settle under the finger (a remount mid-press drops the tap). And the list
 * itself: no phantom height, so a short list doesn't scroll into nothing.
 */

import type { WelcomeFrame } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { type ReactElement, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Agents from '../src/app/(tabs)/agents/index';
import { AgentRow } from '../src/components/AgentRow';
import { setApp } from '../src/lib/store';
import { agent } from './helpers';

const mockNavigate = jest.fn<void, [unknown]>();
let mockMounts = 0;
let mockListProps: { contentContainerStyle?: unknown } = {};

// expo-router's Link as it behaves on iOS: a Link holding a Link.Menu is a
// different component (its native preview link) from one without, so
// flipping the menu on or off remounts whatever it wraps.
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Trigger = ({ children, ...slot }: { children: ReactElement }) =>
    React.cloneElement(children, slot);
  const Menu = () => null;
  const MenuAction = () => null;
  const press = (children: ReactNode, href: unknown) => {
    const trigger = React.Children.toArray(children).find(
      (c) => React.isValidElement(c) && c.type === Trigger
    ) as ReactElement<{ children: ReactElement }> | undefined;
    const child = trigger ?? (children as ReactElement);
    return React.cloneElement(child, {
      onPress: () => {
        mockNavigate(href);
      },
    } as never);
  };
  const Plain = ({ children, href }: { children: ReactNode; href: unknown }) =>
    press(children, href);
  const WithPreview = ({ children, href }: { children: ReactNode; href: unknown }) =>
    press(children, href);
  const Link = (p: { children: ReactNode; href: unknown }) =>
    React.Children.toArray(p.children).some((c) => React.isValidElement(c) && c.type === Menu)
      ? React.createElement(WithPreview, p)
      : React.createElement(Plain, p);
  Object.assign(Link, { Trigger, Menu, MenuAction });
  return {
    Link,
    useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
    Stack: { Screen: () => null },
  };
});
jest.mock('react-native-reanimated', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  for (const k of ['duration', 'delay', 'springify', 'damping', 'mass']) preset[k] = () => preset;
  return {
    __esModule: true,
    default: {
      View: RN.View,
      FlatList: (p: object) => {
        mockListProps = p;
        return React.createElement(RN.FlatList as never, p);
      },
    },
    FadeIn: preset,
    FadeOut: preset,
    FadeInDown: preset,
    LinearTransition: preset,
    interpolate: () => 0,
    useAnimatedStyle: () => ({}),
    useSharedValue: (v: number) => ({ value: v }),
    withTiming: (v: number) => v,
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RN.View };
});
jest.mock('../src/lib/session', () => ({
  canCall: () => false,
  describeError: String,
  call: jest.fn(),
}));
jest.mock('../src/lib/quota', () => ({ useQuotaLines: () => [] }));
jest.mock('../src/components/QuotaLines', () => ({ QuotaLines: () => null }));
jest.mock('../src/components/ChatView', () => ({ ChatView: () => null }));
jest.mock('../src/components/ConnectionPill', () => ({
  ConnectionNotice: () => null,
  LinkProblem: () => null,
  useLinkState: () => null,
  useNow: () => Date.now(),
}));
// The avatar counts how often the row under it mockMounts.
jest.mock('../src/components/agent', () => ({
  AgentAvatar: function Avatar() {
    jest.requireActual<typeof import('react')>('react').useEffect(() => {
      mockMounts += 1;
    }, []);
    return null;
  },
  Spinner: () => null,
  StatusMark: () => null,
}));

const chief = agent({ id: 'chief', name: 'Chief of Staff', isMain: true, unread: 0 });
const full = { update: true, markUnread: true };
const none = { update: false, markUnread: false };

beforeEach(() => {
  mockNavigate.mockClear();
  mockMounts = 0;
  setApp({ chats: {} });
});

describe('AgentRow', () => {
  it('opens the chat once for one tap', async () => {
    await render(<AgentRow agent={chief} caps={full} live onAction={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: /^Chief of Staff\./ }));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({ pathname: '/chat/[id]', params: { id: 'chief' } });
  });

  it('calls the split’s onPress once, and doesn’t also mockNavigate', async () => {
    const onPress = jest.fn();
    await render(
      <AgentRow agent={chief} caps={full} live onPress={onPress} onAction={jest.fn()} />
    );
    await fireEvent.press(screen.getByRole('button', { name: /^Chief of Staff\./ }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('drops a role squeezed past reading, and keeps one with room', async () => {
    const fin = agent({ id: 'fin', name: 'Finance', role: 'Invoices and spend', unread: 0 });
    await render(<AgentRow agent={fin} caps={full} live onAction={jest.fn()} />);
    const layout = (w: number) => ({ nativeEvent: { layout: { width: w, height: 16 } } });
    await fireEvent(screen.getByText('Invoices and spend'), 'layout', layout(400));
    expect(screen.getByText('Invoices and spend')).toBeTruthy();
    // "Invo…": gone, rather than a stub.
    await fireEvent(screen.getByText('Invoices and spend'), 'layout', layout(30));
    expect(screen.queryByText('Invoices and spend')).toBeNull();
    // The name still reads, and the row still opens the chat.
    await fireEvent.press(screen.getByRole('button', { name: /^Finance\./ }));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('stays mounted while the link and the welcome settle', async () => {
    const onAction = jest.fn();
    const view = await render(
      <AgentRow agent={chief} caps={none} live={false} onAction={onAction} />
    );
    expect(mockMounts).toBe(1);
    // The welcome arrives, the link comes up, it drops, the Chief turns unread.
    await view.rerender(<AgentRow agent={chief} caps={full} live={false} onAction={onAction} />);
    await view.rerender(<AgentRow agent={chief} caps={full} live onAction={onAction} />);
    await view.rerender(<AgentRow agent={chief} caps={full} live={false} onAction={onAction} />);
    await view.rerender(
      <AgentRow agent={{ ...chief, unread: 2 }} caps={none} live onAction={onAction} />
    );
    expect(mockMounts).toBe(1);
    // And the row that survived still opens the chat.
    await fireEvent.press(screen.getByRole('button', { name: /^Chief of Staff\./ }));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('Home’s list', () => {
  it('adds no height of its own: a list with only the Chief can’t scroll past it', async () => {
    setApp({
      overview: { agents: [chief], engineReady: true, engines: [] } as never,
      link: { kind: 'connected' } as never,
      welcome: { methods: [] } as unknown as WelcomeFrame,
      rooms: null,
      chats: {},
    });
    await render(<Agents />);
    expect(screen.getByText('Chief of Staff')).toBeTruthy();
    const content = StyleSheet.flatten(mockListProps.contentContainerStyle as object) as Record<
      string,
      unknown
    >;
    // Grown to the list's height, the content is that height plus the
    // large title's and the tab bar's insets: always scrollable by both.
    expect(content.flexGrow).toBeUndefined();
    expect(content.flex).toBeUndefined();
    expect(content.minHeight).toBeUndefined();
    expect(content.height).toBeUndefined();
  });
});
