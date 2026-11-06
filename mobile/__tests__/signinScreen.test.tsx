/**
 * The sign-in screen against a stubbed Mac: it opens, shows the page, sends
 * a hidden field once with `secure`, and wipes it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SignInFromPhone from '../src/app/signin';

const calls: { method: string; params: unknown }[] = [];
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ agentId: 'qa', requestId: 'req_1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('../src/components/agent', () => ({ Spinner: () => null }));
jest.mock('expo-haptics', () => ({}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/lib/haptics', () => ({
  haptic: { select: jest.fn(), success: jest.fn(), error: jest.fn() },
}));
jest.mock('../src/lib/session', () => ({ describeError: (e: Error) => e.message }));
jest.mock('../src/lib/phoneSignin', () => ({
  signinBegin: jest.fn(async () => ({
    sessionId: 's1',
    domain: 'example.com',
    title: 'Example',
    idleSeconds: 300,
  })),
  signinFrame: jest.fn(async () => ({
    state: 'live',
    host: 'www.example.com',
    image: '/9j/2w==',
    width: 800,
    height: 560,
  })),
  signinInput: jest.fn(async (_id: string, input: unknown) => {
    calls.push({ method: 'input', params: input });
    return null;
  }),
  signinDone: jest.fn(async () => ({ outcome: 'signed_out' })),
  signinStop: jest.fn(async () => null),
}));

describe('the sign-in screen', () => {
  it('never hangs on opening: it times out, and Try the agents’ browser asks for it', async () => {
    const ps = jest.requireMock('../src/lib/phoneSignin');
    jest.useFakeTimers();
    try {
      ps.signinBegin.mockImplementationOnce(() => new Promise(() => {}));
      await render(<SignInFromPhone />);
      expect(screen.getByText('Your Mac')).toBeTruthy();
      await act(async () => {
        jest.advanceTimersByTime(25_000);
      });
      expect(screen.getByText(/didn’t open the sign-in in time/)).toBeTruthy();
      await fireEvent.press(screen.getByTestId('signin-retry-agents'));
      expect(ps.signinBegin).toHaveBeenLastCalledWith('qa', 'req_1', 'agents_browser');
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens, shows the page, and types a hidden field once', async () => {
    await render(<SignInFromPhone />);
    expect(await screen.findByText('example.com')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 400)));
    await fireEvent.press(screen.getByTestId('signin-secure'));
    expect(screen.getByTestId('signin-field').props.secureTextEntry).toBe(true);
    await fireEvent.changeText(screen.getByTestId('signin-field'), 'correct-horse');
    await fireEvent.press(screen.getByTestId('signin-type'));
    expect(calls).toEqual([
      { method: 'input', params: { kind: 'type', text: 'correct-horse', secure: true } },
    ]);
    // Wiped on send: nothing left to type again.
    expect(screen.getByTestId('signin-type').props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByText('correct-horse')).toBeNull();
  });
});
