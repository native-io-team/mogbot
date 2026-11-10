/**
 * The living page above the messages (`components/ConversationPage`): read
 * from the Mac only where it serves `agents.page`, drawn with the blocks,
 * versions on a tap, an older one opened, folding, unpinning and pinning back.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { pageMock } from '../dev/mock-page';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  preset.duration = () => preset;
  preset.delay = () => preset;
  return {
    __esModule: true,
    default: { View },
    FadeIn: preset,
    FadeOut: preset,
    LinearTransition: preset,
  };
});
jest.mock('expo-haptics', () => ({}));
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: {
    light: jest.fn(),
    select: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));
const mockPages = pageMock(Date.now());
const mockServed = { page: true };
const mockCall = jest.fn((method: string, p: Record<string, unknown>) => {
  if (method === 'agents.page') return Promise.resolve(mockPages.get(String(p.agentId)));
  if (method === 'agents.pageVersion')
    return Promise.resolve(mockPages.version(String(p.agentId), Number(p.version)));
  if (method === 'agents.pagePin')
    return Promise.resolve(mockPages.pin(String(p.agentId), p.pinned === true));
  return Promise.reject(new Error(method));
});
jest.mock('../src/lib/session', () => ({
  call: (m: string, p: Record<string, unknown>) => mockCall(m, p),
  canCall: () => mockServed.page,
  attachmentSource: () => ({ uri: 'https://mac.example/a.png' }),
  describeError: String,
  send: jest.fn(),
}));
jest.mock('../src/components/agent', () => ({ Spinner: () => null }));
jest.mock('../src/components/menu', () => ({ choose: jest.fn() }));

import { ConversationPage } from '../src/components/ConversationPage';
import { resetPages } from '../src/lib/page';

const side = { left: 0, right: 0 };
const draw = async (agentId = 'budget') =>
  await render(
    <ConversationPage
      agentId={agentId}
      conversation="first"
      turn="idle:x"
      side={side}
      onError={jest.fn()}
    />
  );

// A phone's screen, in points: a page starts folded to its bar there.
const rn = jest.requireActual<typeof import('react-native')>('react-native');
beforeEach(() => {
  jest
    .spyOn(rn, 'useWindowDimensions')
    .mockReturnValue({ width: 402, height: 874, scale: 3, fontScale: 1 });
  resetPages();
  mockServed.page = true;
  mockCall.mockClear();
  mockPages.pin('budget', true);
});

describe('ConversationPage (phone)', () => {
  it('starts folded to its bar on a phone, and opens on a tap', async () => {
    await draw();
    expect(await screen.findByText('November budget')).toBeTruthy();
    expect(screen.getByText('Updated 3 min ago by Log the day’s card spend')).toBeTruthy();
    expect(screen.queryByText('Where it went')).toBeNull();
    await fireEvent.press(screen.getByLabelText('November budget. Show the page'));
    expect(screen.getByText('Where it went')).toBeTruthy();
    expect(mockCall).toHaveBeenCalledWith('agents.page', {
      agentId: 'budget',
      conversationId: 'first',
    });
  });

  it('lists versions on a tap, and opens an older one', async () => {
    await draw();
    await fireEvent.press(await screen.findByLabelText('Updated 3 min ago by Log the day’s card spend. What changed'));
    // A routine's version names it; one whose routine isn't known says "a routine".
    expect(screen.getByText('Version 4 · 3 min ago · by Log the day’s card spend')).toBeTruthy();
    expect(screen.getByText('Version 2 · 2 d ago · by a routine')).toBeTruthy();
    expect(screen.getByText('Made the page — Started the month')).toBeTruthy();
    expect(screen.getByText('“Log the day’s card spend” keeps this page up to date')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByText('Version 1 · 4 d ago'));
    });
    expect(screen.getByText('Version 1, as it was 4 d ago. Back to the latest')).toBeTruthy();
    expect(screen.queryByText('Where it went')).toBeNull();
  });

  it('folds, and unpins', async () => {
    await draw();
    await fireEvent.press(await screen.findByLabelText('November budget. Show the page'));
    await fireEvent.press(await screen.findByLabelText('November budget. Fold the page'));
    expect(screen.queryByText('Where it went')).toBeNull();
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Unpin the page'));
    });
    expect(mockCall).toHaveBeenCalledWith('agents.pagePin', {
      agentId: 'budget',
      conversationId: 'first',
      pinned: false,
    });
    expect(screen.queryByTestId('conversation-page')).toBeNull();
    // Unpinned, one line brings it back: the phone's header has no Pin page.
    await act(async () => {
      await fireEvent.press(screen.getByLabelText('Pin the page “November budget”'));
    });
    expect(mockCall).toHaveBeenCalledWith('agents.pagePin', {
      agentId: 'budget',
      conversationId: 'first',
      pinned: true,
    });
    expect(await screen.findByTestId('conversation-page')).toBeTruthy();
  });

  it('shows nothing where there is no page, or the Mac keeps none', async () => {
    await draw('someone-else');
    await act(async () => {});
    expect(screen.queryByTestId('conversation-page')).toBeNull();
    resetPages();
    mockServed.page = false;
    mockCall.mockClear();
    await draw();
    await act(async () => {});
    expect(mockCall).not.toHaveBeenCalled();
    expect(screen.queryByTestId('conversation-page')).toBeNull();
  });

  it('reads once per turn: not again on reopening, again when the turn moves on', async () => {
    const pageReads = () => mockCall.mock.calls.filter(([m]) => m === 'agents.page').length;
    const view = (turn: string) => (
      <ConversationPage
        agentId="budget"
        conversation="first"
        turn={turn}
        side={side}
        onError={jest.fn()}
      />
    );
    const first = await render(view('working:a'));
    await screen.findByText('November budget');
    await first.unmount();
    const again = await render(view('working:a'));
    await act(async () => {});
    expect(pageReads()).toBe(1);
    await again.unmount();
    await render(view('idle:b'));
    await waitFor(() => expect(pageReads()).toBe(2));
    await act(async () => {});
    expect(pageReads()).toBe(2);
  });
});

describe('ConversationPage (a tall screen)', () => {
  it('starts open where there is room, its tiles flat', async () => {
    jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: 1024, height: 1366, scale: 2, fontScale: 1 });
    await draw();
    expect(await screen.findByText('Where it went')).toBeTruthy();
    const tile = screen.getAllByTestId('metric-tile')[0];
    const style = Object.assign({}, ...[tile.props.style].flat(Infinity).filter(Boolean));
    expect(style.boxShadow).toBe('none');
  });
});
