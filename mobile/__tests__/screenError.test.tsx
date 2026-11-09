/**
 * A screen that throws while drawing is caught by its own boundary, so the
 * navigator (header, back) keeps working; the root's last resort also lets
 * the splash go, or a throw before it hid would leave the app on it.
 */

import { fireEvent, render, screen } from '@testing-library/react-native';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { DevSettings } from 'react-native';
import { reloadApp, RootError, ScreenError } from '../src/components/ScreenError';

const mockBack = jest.fn();
let mockCanGoBack = true;
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, canGoBack: () => mockCanGoBack }),
}));
const mockHideAsync = jest.fn(() => Promise.resolve());
jest.mock('expo-splash-screen', () => ({ hideAsync: () => mockHideAsync() }));
const mockReloadAsync = jest.fn(() => Promise.resolve());
jest.mock('expo-updates', () => ({ reloadAsync: () => mockReloadAsync() }));
const mockRecordCrash = jest.fn((..._args: unknown[]) => Promise.resolve());
jest.mock('../src/lib/crash', () => ({
  recordCrash: (...a: unknown[]) => mockRecordCrash(...a),
}));

beforeEach(() => {
  mockBack.mockClear();
  mockHideAsync.mockClear();
  mockRecordCrash.mockClear();
  mockCanGoBack = true;
});

describe('ScreenError', () => {
  it('logs the error, retries, and offers the way back inside a stack', async () => {
    const retry = jest.fn(() => Promise.resolve());
    const error = new Error('boom');
    await render(<ScreenError error={error} retry={retry} />);
    expect(mockRecordCrash).toHaveBeenCalledWith(error, 'render', false);
    await fireEvent.press(screen.getByText('Try again'));
    expect(retry).toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Go back'));
    expect(mockBack).toHaveBeenCalled();
  });

  it('has no Go back where there is nowhere to go', async () => {
    mockCanGoBack = false;
    await render(<ScreenError error={new Error('x')} retry={() => Promise.resolve()} />);
    expect(screen.queryByText('Go back')).toBeNull();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('at the root, lets the splash go', async () => {
    await render(<RootError error={new Error('x')} retry={() => Promise.resolve()} />);
    expect(mockHideAsync).toHaveBeenCalled();
    expect(screen.getByText('This couldn’t be shown.')).toBeTruthy();
  });

  it('at the root, offers Reload, which starts the app afresh', async () => {
    mockReloadAsync.mockClear();
    await render(<RootError error={new Error('x')} retry={() => Promise.resolve()} />);
    expect(screen.getByText('Try again')).toBeTruthy();
    await fireEvent.press(screen.getByText('Reload'));
    expect(mockReloadAsync).toHaveBeenCalled();
  });

  it('a route offers no Reload: Try again and Go back are enough there', async () => {
    await render(<ScreenError error={new Error('x')} retry={() => Promise.resolve()} />);
    expect(screen.queryByText('Reload')).toBeNull();
  });

  it('reloads through the bundler where the update runtime can’t (development)', async () => {
    mockReloadAsync.mockImplementationOnce(() => Promise.reject(new Error('dev')));
    const devReload = jest.spyOn(DevSettings, 'reload').mockImplementation(() => {});
    await reloadApp();
    expect(devReload).toHaveBeenCalled();
    devReload.mockRestore();
  });
});

describe('every route', () => {
  const app = join(__dirname, '../src/app');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const routes = files(app).filter((p) => !/\/(_layout|\+[^/]*)\.tsx$/.test(p));

  it('exports its own ErrorBoundary, and the root layout one too', () => {
    expect(routes.length).toBeGreaterThan(20);
    for (const p of [...routes, join(app, '_layout.tsx')]) {
      const route = p.slice(app.length);
      expect({
        route,
        boundary: /export \{ \w+ as ErrorBoundary \}/.test(readFileSync(p, 'utf8')),
      }).toEqual({
        route,
        boundary: true,
      });
    }
  });
});
