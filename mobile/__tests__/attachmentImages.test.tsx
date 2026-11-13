/**
 * Images an agent shares are real pictures on the phone, never empty boxes.
 *
 * The phone asked for `/v1/agents/<id>/attachments/attachments/<msg>/<name>`
 * (the attachment's own path, which already starts with `attachments/`,
 * under a route prefix that added it again), the Mac answered 404, and every
 * image tile stayed its empty background. A file that really is gone now
 * says so, with its name.
 *
 * Over the relay a ten-picture result card drew as blank space on an
 * iPhone: each tile was a placeholder view swapped for another (a Pressable
 * with an Image) when its picture arrived, inside a card whose layout
 * animation was running. A tile is now one view from loading to loaded, and
 * a picture that never comes says so and can be tried again.
 */

import { HTTP } from '@shipstudio/companion-protocol';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-image', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Image: (props: {
      source: { uri: string };
      onError?: () => void;
      onLoad?: (e: unknown) => void;
      transition?: number;
    }) => (
      <View
        testID={`img:${props.source.uri}`}
        accessibilityHint={props.transition ? `fade ${props.transition}` : undefined}
        onTouchEnd={props.onError}
        onTouchStart={() => props.onLoad?.({ source: { width: 400, height: 300 } })}
      />
    ),
  };
});

/** What `attachmentSource` answers: the direct route unless a test says otherwise. */
const direct = (agentId: string, path: string, width?: number) => ({
  uri: `https://mac.example${jest
    .requireActual<
      typeof import('@shipstudio/companion-protocol')
    >('@shipstudio/companion-protocol')
    .HTTP.attachment(agentId, path)}${width ? `?w=${width * 2}` : ''}`,
  cacheKey: `${agentId}/${path}`,
});
const mockSource = jest.fn(direct);
const mockRetry = jest.fn();
jest.mock('../src/lib/session', () => ({
  attachmentSource: (...args: [string, string, number?]) => mockSource(...args),
  retryAttachmentSource: (...args: unknown[]) => mockRetry(...args),
  describeError: String,
  download: jest.fn(),
}));
jest.mock('../src/components/agent', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Spinner: () => <View testID="spinner" /> };
});
jest.mock('../src/components/menu', () => ({ choose: jest.fn() }));

import {
  Attachments,
  IMAGE_UNAVAILABLE,
  TAP_TO_RETRY,
  THUMB_GIVE_UP_MS,
  THUMB_SLOW_MS,
} from '../src/components/attachments';

beforeEach(() => {
  mockSource.mockImplementation(direct);
  mockRetry.mockReset();
});
afterEach(() => jest.useRealTimers());

describe('attachment routes', () => {
  it('name the attachments folder once, as the Mac serves it', () => {
    expect(HTTP.attachment('a1', 'attachments/m1/post 1.jpg')).toBe(
      '/v1/agents/a1/attachments/m1/post%201.jpg'
    );
    // A path given without its folder lands in the same place.
    expect(HTTP.attachment('a1', 'm1/post.jpg')).toBe('/v1/agents/a1/attachments/m1/post.jpg');
  });
});

describe('a shared image', () => {
  const image = {
    name: 'scheduled-posts.jpg',
    path: 'attachments/m9/scheduled-posts.jpg',
    mime: 'image/jpeg',
    size: 68_000,
  };

  it('loads from the route the Mac answers, with no fade', async () => {
    await render(<Attachments agentId="social" attachments={[image]} />);
    const img = screen.getByTestId(
      'img:https://mac.example/v1/agents/social/attachments/m9/scheduled-posts.jpg?w=464'
    );
    expect(img.props.accessibilityHint).toBeUndefined();
  });

  it('says it is not available, with its name, when it cannot be fetched', async () => {
    await render(<Attachments agentId="social" attachments={[image]} />);
    await fireEvent(screen.getByTestId(/^img:/), 'touchEnd');
    expect(screen.getByText(IMAGE_UNAVAILABLE)).toBeTruthy();
    expect(screen.getByText(TAP_TO_RETRY)).toBeTruthy();
    expect(screen.getByText('scheduled-posts.jpg')).toBeTruthy();
  });

  it('tries again on a tap', async () => {
    await render(<Attachments agentId="social" attachments={[image]} />);
    await fireEvent(screen.getByTestId(/^img:/), 'touchEnd');
    await fireEvent.press(screen.getByText(TAP_TO_RETRY));
    expect(mockRetry).toHaveBeenCalledWith('social', image.path, expect.any(Number));
    expect(screen.queryByText(IMAGE_UNAVAILABLE)).toBeNull();
    expect(screen.getByTestId(/^img:/)).toBeTruthy();
  });

  it('shows it is loading after a short wait, and fails with no answer', async () => {
    jest.useFakeTimers();
    await render(<Attachments agentId="social" attachments={[image]} />);
    expect(screen.queryByTestId('spinner')).toBeNull();
    await act(() => jest.advanceTimersByTime(THUMB_SLOW_MS));
    expect(screen.getByTestId('spinner')).toBeTruthy();
    await act(() => jest.advanceTimersByTime(THUMB_GIVE_UP_MS));
    expect(screen.getByText(IMAGE_UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByTestId('spinner')).toBeNull();
  });

  it('a loaded picture never shows the spinner', async () => {
    jest.useFakeTimers();
    await render(<Attachments agentId="social" attachments={[image]} />);
    await fireEvent(screen.getByTestId(/^img:/), 'touchStart');
    await act(() => jest.advanceTimersByTime(THUMB_GIVE_UP_MS * 2));
    expect(screen.queryByTestId('spinner')).toBeNull();
    expect(screen.queryByText(IMAGE_UNAVAILABLE)).toBeNull();
  });
});

describe('over the relay', () => {
  const images = Array.from({ length: 10 }, (_, i) => ({
    name: `post-${i}.jpg`,
    path: `attachments/m1/post-${i}.jpg`,
    mime: 'image/jpeg',
    size: 40_000,
  }));

  it('keeps one tile per picture from waiting to drawn', async () => {
    let arrived = false;
    mockSource.mockImplementation((agentId, path) =>
      arrived
        ? { uri: `file:///cache/${path}`, cacheKey: `${agentId}/${path}` }
        : ({ cacheKey: `${agentId}/${path}` } as ReturnType<typeof direct>)
    );
    const view = await render(<Attachments agentId="a" attachments={images} />);
    const before = images.map((i) => screen.getByTestId(`thumb:${i.path}`));
    expect(screen.queryAllByTestId(/^img:/)).toHaveLength(0);
    arrived = true;
    await view.rerender(<Attachments agentId="a" attachments={images} />);
    const after = images.map((i) => screen.getByTestId(`thumb:${i.path}`));
    after.forEach((tile, i) => expect(tile).toBe(before[i]));
    expect(screen.getAllByTestId(/^img:file:/)).toHaveLength(10);
  });

  it('a picture that could not be fetched says so and asks the relay again', async () => {
    mockSource.mockImplementation(() => null as unknown as ReturnType<typeof direct>);
    await render(<Attachments agentId="a" attachments={[images[0]]} />);
    expect(screen.getByText(IMAGE_UNAVAILABLE)).toBeTruthy();
    await fireEvent.press(screen.getByText(TAP_TO_RETRY));
    expect(mockRetry).toHaveBeenCalledWith('a', images[0].path, expect.any(Number));
  });
});
