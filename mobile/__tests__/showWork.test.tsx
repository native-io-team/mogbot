/**
 * Agents showing their work on the phone: a visual result is one card with a
 * compare per page, a reply's links to the Mac's own servers are never dead
 * links, and the viewer pages through every picture in the chat.
 */

import 'react-native-gesture-handler/jestSetup';
import {
  comparePages,
  galleryOf,
  type AgentMessage,
  type Attachment,
  type LocalLink,
  type ResultCard,
  type WelcomeFrame,
} from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { Text } from 'react-native';

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('expo-image', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Image: (p: { source?: { uri?: string } }) => <View testID={`img:${p.source?.uri}`} /> };
});
jest.mock('react-native-reanimated', () =>
  jest.requireActual<typeof import('./reanimatedStub')>('./reanimatedStub').reanimated()
);
jest.mock('react-native-worklets', () =>
  jest.requireActual<typeof import('./reanimatedStub')>('./reanimatedStub').worklets()
);
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-haptics', () => ({}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { light: jest.fn(), select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
const mockWatchLive = jest.fn();
jest.mock('../src/lib/session', () => ({
  attachmentSource: (agentId: string, path: string) => ({ uri: `${agentId}/${path}` }),
  describeError: String,
  download: jest.fn(),
  watchLive: (...a: unknown[]) => mockWatchLive(...a),
}));
const mockOpenHere = jest.fn();
jest.mock('../src/lib/logins', () => ({ openHere: (u: string) => mockOpenHere(u) }));
jest.mock('../src/components/agent', () => ({ Spinner: () => null }));
jest.mock('../src/lib/files', () => ({ share: jest.fn(), isPreviewableImage: () => true }));

import { Compare } from '../src/components/compare';
import { LocalLinks } from '../src/components/localLinks';
import { GalleryContext, getGallery, viewerParams } from '../src/lib/gallery';
import { useApp } from '../src/lib/store';
import Viewer from '../src/app/viewer';

const shot = (name: string): Attachment => ({
  name,
  path: `attachments/m2/${name}`,
  mime: 'image/png',
  size: 1,
});

const card: ResultCard = {
  id: 'r',
  version: 1,
  title: 'Moss & Co. refresh',
  summary: 'New type and spacing on three pages.',
  items: [
    { kind: 'file', file: shot('home-b.png'), role: 'before', page: 'Home' },
    { kind: 'file', file: shot('home-a.png'), role: 'after', page: 'Home' },
    { kind: 'file', file: shot('menu-b.png'), role: 'before', page: 'Menu' },
    {
      kind: 'file',
      file: shot('menu-a.png'),
      role: 'after',
      page: 'Menu',
      label: 'Menu, larger prices',
    },
    { kind: 'file', file: shot('visit-a.png'), role: 'after', page: 'Visit' },
  ],
};

const connect = (features: string[] = []) =>
  useApp.setState({
    link: { kind: 'connected', route: 'tailscale' } as never,
    welcome: { methods: ['agents.watchLive'], features } as unknown as WelcomeFrame,
  });

async function sized(node: React.ReactElement) {
  await render(node);
  await act(() =>
    fireEvent(screen.getByTestId('result-compare'), 'layout', {
      nativeEvent: { layout: { width: 320, height: 200 } },
    })
  );
}

describe('the compare on a visual result', () => {
  beforeEach(() => mockPush.mockClear());

  it('starts as a slider on the first page, and switches pages', async () => {
    await sized(<Compare agentId="design" pages={comparePages(card.items)} />);
    expect(screen.getByTestId('compare-slider')).toBeTruthy();
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText('Before · After')).toBeTruthy();
    await fireEvent.press(screen.getByText('Menu'));
    expect(screen.getByText('Before · Menu, larger prices')).toBeTruthy();
  });

  it('shows the two side by side on request', async () => {
    await sized(<Compare agentId="design" pages={comparePages(card.items)} />);
    await fireEvent.press(screen.getByTestId('compare-mode'));
    expect(screen.getByTestId('compare-side')).toBeTruthy();
    expect(screen.queryByTestId('compare-slider')).toBeNull();
    expect(screen.getByText('Slider')).toBeTruthy();
  });

  it('a page with one side shows that picture alone, with no mode switch', async () => {
    await sized(<Compare agentId="design" pages={comparePages(card.items)} />);
    await fireEvent.press(screen.getByText('Visit'));
    expect(screen.getByTestId('compare-side')).toBeTruthy();
    expect(screen.queryByTestId('compare-mode')).toBeNull();
    expect(screen.getByTestId('img:design/attachments/m2/visit-a.png')).toBeTruthy();
  });

  it('opens a picture in the gallery of the whole chat', async () => {
    const gallery = galleryOf([{ id: 'm2', agentId: 'design', result: card }]);
    await render(
      <GalleryContext.Provider value={gallery}>
        <Compare agentId="design" pages={comparePages(card.items)} />
      </GalleryContext.Provider>
    );
    await act(() =>
      fireEvent(screen.getByTestId('result-compare'), 'layout', {
        nativeEvent: { layout: { width: 320, height: 200 } },
      })
    );
    await fireEvent.press(screen.getByTestId('compare-mode'));
    await fireEvent.press(screen.getByLabelText('After, image'));
    const sent = mockPush.mock.calls[0][0].params as Record<string, string>;
    expect(sent.path).toBe('attachments/m2/home-a.png');
    expect(getGallery(sent.gallery)?.map((g) => g.file.name)).toEqual([
      'home-b.png',
      'home-a.png',
      'menu-b.png',
      'menu-a.png',
      'visit-a.png',
    ]);
  });
});

describe("links to the Mac's own servers", () => {
  const links: LocalLink[] = [
    { url: 'http://localhost:3401/', label: 'after', port: 3401, path: '/x/copy', project: '/x' },
    { url: 'http://localhost:5173/', label: 'localhost:5173', port: 5173 },
  ];
  beforeEach(() => {
    mockWatchLive.mockReset();
    mockOpenHere.mockReset();
  });

  it('offers Watch live on a known site when the Mac serves it, by link index', async () => {
    connect(['watch.links']);
    mockWatchLive.mockResolvedValue({ url: 'https://mac.tail.ts.net:47464/w/t', expiresAt: 1 });
    await render(<LocalLinks agentId="a" messageId="m" links={links} onError={jest.fn()} />);
    expect(screen.getAllByText('Watch live')).toHaveLength(1);
    await act(async () => fireEvent.press(screen.getByText('Watch live')));
    expect(mockWatchLive).toHaveBeenCalledWith('a', 'm', 0);
    expect(mockOpenHere).toHaveBeenCalledWith('https://mac.tail.ts.net:47464/w/t');
  });

  it('is a plain chip, never a link, on an older Mac or an unknown server', async () => {
    connect([]);
    await render(<LocalLinks agentId="a" messageId="m" links={links} onError={jest.fn()} />);
    expect(screen.queryByText('Watch live')).toBeNull();
    expect(screen.getByText('Running on your computer · localhost:5173')).toBeTruthy();
    expect(screen.getByLabelText('running on your computer at localhost:5173')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the viewer as a gallery', () => {
  const messages: Pick<AgentMessage, 'id' | 'agentId' | 'attachments' | 'result'>[] = [
    { id: 'm1', agentId: 'design', attachments: [shot('moodboard.png')] },
    { id: 'm2', agentId: 'design', result: card },
    { id: 'm3', agentId: 'design', attachments: [shot('logo.png'), shot('icon.png')] },
  ];

  it('opens on the picture tapped, with its place and caption', async () => {
    const gallery = galleryOf(messages);
    expect(gallery).toHaveLength(8);
    mockParams = viewerParams(gallery, 'design', shot('menu-b.png'));
    await render(<Viewer />);
    expect(screen.getByText('4 of 8')).toBeTruthy();
    expect(screen.getByTestId('viewer-caption').props.children).toBe('Menu · Before');
  });

  it('swipes to the next picture at fit, and the counter and caption follow', async () => {
    mockParams = viewerParams(galleryOf(messages), 'design', shot('menu-b.png'));
    await render(<Viewer />);
    await act(() => {
      fireGestureHandler(getByGestureTestId('viewer-pan'), [
        { translationX: 0, translationY: 0, velocityX: 0 },
        { translationX: -60, translationY: 0, changeX: -60, velocityX: -100 },
        { translationX: -200, translationY: 0, changeX: -140, velocityX: -100 },
      ]);
    });
    expect(screen.getByText('5 of 8')).toBeTruthy();
    expect(screen.getByTestId('viewer-caption').props.children).toBe('Menu, larger prices');
  });

  it('a picture outside any chat is a gallery of one, with no counter', async () => {
    mockParams = {
      agentId: 'design',
      path: 'attachments/m9/x.png',
      name: 'x.png',
      mime: 'image/png',
    };
    await render(<Viewer />);
    expect(screen.queryByTestId('viewer-counter')).toBeNull();
    expect(screen.getByTestId('viewer-caption')).toBeTruthy();
  });
});

// Keep Text imported for the JSX runtime in mocks.
void Text;
