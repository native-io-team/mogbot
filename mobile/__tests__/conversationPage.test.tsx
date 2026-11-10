/**
 * The living page above the messages (`components/ConversationPage`): read
 * from the Mac only where it serves `agents.page`, drawn with the blocks,
 * versions on a tap, an older one opened, folding, unpinning.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
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

beforeEach(() => {
  resetPages();
  mockServed.page = true;
  mockCall.mockClear();
  mockPages.pin('budget', true);
});

describe('ConversationPage (phone)', () => {
  it('draws the page under its bar, with when it changed', async () => {
    await draw();
    expect(await screen.findByText('November budget')).toBeTruthy();
    expect(screen.getByText('Updated 3 min ago · v4')).toBeTruthy();
    expect(screen.getByText('Where it went')).toBeTruthy();
    expect(mockCall).toHaveBeenCalledWith('agents.page', {
      agentId: 'budget',
      conversationId: 'first',
    });
  });

  it('lists versions on a tap, and opens an older one', async () => {
    await draw();
    await fireEvent.press(await screen.findByLabelText('Updated 3 min ago · v4. What changed'));
    expect(screen.getByText('v4 · 3 min ago · by a routine')).toBeTruthy();
    expect(screen.getByText('Made the page — Started the month')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByText('v1 · 4 d ago'));
    });
    expect(screen.getByText('v1, as it was 4 d ago. Back to v4')).toBeTruthy();
    expect(screen.queryByText('Where it went')).toBeNull();
  });

  it('folds, and unpins', async () => {
    await draw();
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
});
