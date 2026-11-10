import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from '@tauri-apps/plugin-updater';
import { checkForUpdate, downloadUpdate, releaseUpdate } from './updater';
import {
  checkForUpdatesNow,
  FIRST_CHECK_DELAY_MS,
  getUpdateSnapshot,
  resetUpdateStoreForTests,
  startAutomaticUpdateChecks,
  UPDATE_CHECK_INTERVAL_MS,
  updateCheckMessage,
} from './updateStore';

vi.mock('./updater', () => ({
  UPDATES_ENABLED: true,
  isMockUpdateSimulationEnabled: () => false,
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  releaseUpdate: vi.fn(() => Promise.resolve()),
  restartApp: vi.fn(),
}));

vi.mock('./window', () => ({ getWindowLabel: () => 'main' }));

vi.mock('./analytics', () => ({
  trackEvent: vi.fn(),
  trackError: vi.fn(),
}));

function offer(version: string) {
  const update = { version } as unknown as Update;
  vi.mocked(checkForUpdate).mockResolvedValue({
    update,
    info: { version, date: undefined, body: '' },
  });
  return update;
}

beforeEach(() => {
  vi.stubEnv('DEV', false);
  localStorage.clear();
  resetUpdateStoreForTests();
  vi.mocked(checkForUpdate).mockReset();
  vi.mocked(downloadUpdate).mockReset();
  vi.mocked(releaseUpdate).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetUpdateStoreForTests();
});

describe('automatic checks', () => {
  it('checks shortly after launch, then every four hours', async () => {
    vi.useFakeTimers();
    vi.mocked(checkForUpdate).mockResolvedValue(null);

    startAutomaticUpdateChecks(() => 'main');
    startAutomaticUpdateChecks(() => 'main'); // a remounted sidebar: still one schedule
    expect(checkForUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('runs only in the main window, so two windows never download twice', async () => {
    vi.useFakeTimers();
    vi.mocked(checkForUpdate).mockResolvedValue(null);
    startAutomaticUpdateChecks(() => 'project-123');
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS * 2);
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('never runs in a development build', async () => {
    vi.stubEnv('DEV', true);
    vi.useFakeTimers();
    vi.mocked(checkForUpdate).mockResolvedValue(null);
    startAutomaticUpdateChecks(() => 'main');
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS * 2);
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it('keeps checking after a failed check', async () => {
    vi.useFakeTimers();
    vi.mocked(checkForUpdate).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null);
    startAutomaticUpdateChecks(() => 'main');
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('checkForUpdatesNow', () => {
  it('downloads a newer version in the background and becomes ready', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    await expect(checkForUpdatesNow()).resolves.toEqual({ kind: 'ready', version: '1.0.1' });
    expect(getUpdateSnapshot()).toMatchObject({ phase: 'ready', dismissed: false });
  });

  it('a manual check answers as soon as the download starts', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockReturnValue(new Promise(() => undefined));
    await expect(checkForUpdatesNow({ manual: true })).resolves.toEqual({
      kind: 'downloading',
      version: '1.0.1',
    });
    expect(getUpdateSnapshot().phase).toBe('downloading');
    // Asking again while it downloads doesn't start a second download.
    await expect(checkForUpdatesNow({ manual: true })).resolves.toEqual({
      kind: 'downloading',
      version: '1.0.1',
    });
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not download the same ready version again', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    await checkForUpdatesNow();
    await checkForUpdatesNow();
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('lets go of an older ready update when a newer one is out', async () => {
    const first = offer('1.0.1');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    await checkForUpdatesNow();
    offer('1.0.2');
    await checkForUpdatesNow();
    expect(releaseUpdate).toHaveBeenCalledWith(first);
    expect(getUpdateSnapshot().info?.version).toBe('1.0.2');
  });

  it('a failed download is forgotten, and the next check starts over', async () => {
    offer('1.0.1');
    vi.mocked(downloadUpdate).mockRejectedValueOnce(new Error('bad signature'));
    await expect(checkForUpdatesNow()).resolves.toMatchObject({ kind: 'failed' });
    expect(getUpdateSnapshot().phase).toBe('idle');
    vi.mocked(downloadUpdate).mockResolvedValue(undefined);
    await expect(checkForUpdatesNow()).resolves.toEqual({ kind: 'ready', version: '1.0.1' });
  });

  it('a development build reports the release without downloading it', async () => {
    vi.stubEnv('DEV', true);
    offer('1.0.1');
    await expect(checkForUpdatesNow({ manual: true })).resolves.toEqual({
      kind: 'dev-build',
      version: '1.0.1',
    });
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it('reports a check that could not reach the feed', async () => {
    vi.mocked(checkForUpdate).mockRejectedValue(new Error('network down'));
    await expect(checkForUpdatesNow({ manual: true })).resolves.toEqual({
      kind: 'failed',
      message: 'network down',
    });
  });
});

describe('updateCheckMessage', () => {
  it('says what the check found', () => {
    expect(updateCheckMessage({ kind: 'up-to-date' })).toEqual({
      text: "You're up to date",
      tone: 'success',
    });
    expect(updateCheckMessage({ kind: 'downloading', version: '1.0.1' }).text).toMatch(
      /1\.0\.1 is downloading/
    );
    expect(updateCheckMessage({ kind: 'ready', version: '1.0.1' }).text).toMatch(
      /Restart to update/
    );
    expect(updateCheckMessage({ kind: 'failed', message: 'x' }).tone).toBe('error');
  });
});
