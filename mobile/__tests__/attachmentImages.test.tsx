/**
 * Images an agent shares are real pictures on the phone, never empty boxes.
 *
 * The phone asked for `/v1/agents/<id>/attachments/attachments/<msg>/<name>`
 * (the attachment's own path, which already starts with `attachments/`,
 * under a route prefix that added it again), the Mac answered 404, and every
 * image tile stayed its empty background. A file that really is gone now
 * says so, with its name.
 */

import { HTTP } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-image', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Image: (props: { source: { uri: string }; onError?: () => void }) => (
      <View testID={`img:${props.source.uri}`} onTouchEnd={props.onError} />
    ),
  };
});
jest.mock('../src/lib/session', () => ({
  attachmentSource: (agentId: string, path: string, width?: number) => ({
    uri: `https://mac.example${jest
      .requireActual<typeof import('@shipstudio/companion-protocol')>(
        '@shipstudio/companion-protocol'
      )
      .HTTP.attachment(agentId, path)}${width ? `?w=${width * 2}` : ''}`,
  }),
  describeError: String,
  download: jest.fn(),
}));
jest.mock('../src/components/agent', () => ({ Spinner: () => null }));
jest.mock('../src/components/menu', () => ({ choose: jest.fn() }));

import { Attachments, IMAGE_UNAVAILABLE } from '../src/components/attachments';

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

  it('loads from the route the Mac answers', async () => {
    await render(<Attachments agentId="social" attachments={[image]} />);
    expect(
      screen.getByTestId(
        'img:https://mac.example/v1/agents/social/attachments/m9/scheduled-posts.jpg?w=464'
      )
    ).toBeTruthy();
  });

  it('says it is not available, with its name, when it cannot be fetched', async () => {
    await render(<Attachments agentId="social" attachments={[image]} />);
    await fireEvent(screen.getByTestId(/^img:/), 'touchEnd');
    expect(screen.getByText(IMAGE_UNAVAILABLE)).toBeTruthy();
    expect(screen.getByText('scheduled-posts.jpg')).toBeTruthy();
  });
});
