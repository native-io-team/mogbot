/**
 * The sign-in screen on the agents' browser: it names where the picture
 * comes from, hides what's typed on its own when the page's field is a
 * password, asks for each picture after the last, and offers "Sign in
 * another way" when the site refuses the window.
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SignInFromPhone from '../src/app/signin';

const mockFrames: { after: number | undefined }[] = [];
let mockBlocked = false;
const mockFallback = jest.fn(async () => ({
  sessionId: 's1',
  domain: 'google.com',
  title: 'Gmail',
  idleSeconds: 300,
  via: 'mac_window',
  frameGapMs: 150,
}));
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
    domain: 'google.com',
    title: 'Gmail',
    idleSeconds: 300,
    via: 'agents_browser',
    frameGapMs: 30,
  })),
  signinFrame: jest.fn(async (_id: string, after?: number) => {
    mockFrames.push({ after });
    const seq = (after ?? 0) + 1;
    return mockBlocked
      ? {
          state: 'blocked',
          host: 'accounts.google.com',
          image: '/9j/2w==',
          width: 780,
          height: 540,
          seq,
          blocked: 'Google won’t sign in to a browser the app is driving.',
        }
      : {
          state: 'live',
          host: 'accounts.google.com',
          image: '/9j/2w==',
          width: 780,
          height: 540,
          seq,
          secure: true,
        };
  }),
  signinFallback: (...a: unknown[]) => (mockFallback as (...b: unknown[]) => unknown)(...a),
  signinInput: jest.fn(async () => null),
  signinDone: jest.fn(async () => ({ outcome: 'signed_out' })),
  signinStop: jest.fn(async () => null),
}));

describe('the sign-in screen on the agents’ browser', () => {
  it('streams, hides a password field by itself, and offers another way when refused', async () => {
    await render(<SignInFromPhone />);
    expect(await screen.findByText('google.com')).toBeTruthy();
    expect(screen.getByText('The agents’ browser on your computer')).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 300)));
    // Each picture is asked for after the one before.
    expect(mockFrames[0].after).toBeUndefined();
    expect(mockFrames.slice(1).every((f, i) => f.after === i + 1)).toBe(true);
    // The page's focused field is a password: hidden without a tap.
    expect(screen.getByTestId('signin-field').props.secureTextEntry).toBe(true);
    expect(screen.queryByTestId('signin-fallback')).toBeNull();

    mockBlocked = true;
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(screen.getByText(/Sign in another way below/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('signin-fallback'));
    expect(mockFallback).toHaveBeenCalledWith('s1');
    expect(await screen.findByText('A Chrome window on your computer')).toBeTruthy();
    mockBlocked = false;
  });
});
