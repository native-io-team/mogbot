import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT,
  DASHBOARD_VISIBILITY_CHANGED_EVENT,
  ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT,
  KEEP_DEV_SERVERS_RUNNING_LOCAL_CHANGED_EVENT,
  getKeepDevServersRunning,
  setCompactWorkspaceToolbarEnabled,
  setElementBreadcrumbEnabled,
  setKeepDevServersRunning,
  setSlackCtaHidden,
} from './settings';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('dashboard visibility settings', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it.each([['slackCta', 'set_slack_cta_hidden', setSlackCtaHidden]] as const)(
    'notifies the home screen when %s is persisted',
    async (key, command, setter) => {
      const listener = vi.fn();
      window.addEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, listener);

      await setter(true);

      expect(invokeMock).toHaveBeenCalledWith(command, { hidden: true });
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]?.[0]).toMatchObject({
        detail: { key, hidden: true },
      });

      window.removeEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, listener);
    }
  );
});

describe('workspace toolbar setting', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('persists and broadcasts the compact workspace toolbar preference', async () => {
    const listener = vi.fn();
    window.addEventListener(COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT, listener);

    await setCompactWorkspaceToolbarEnabled(true);

    expect(invokeMock).toHaveBeenCalledWith('set_compact_workspace_toolbar_enabled', {
      enabled: true,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: true });

    window.removeEventListener(COMPACT_WORKSPACE_TOOLBAR_CHANGED_EVENT, listener);
  });
});

describe('element breadcrumb setting', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('persists and broadcasts the element breadcrumb preference', async () => {
    const listener = vi.fn();
    window.addEventListener(ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT, listener);

    await setElementBreadcrumbEnabled(false);

    expect(invokeMock).toHaveBeenCalledWith('set_element_breadcrumb_enabled', { enabled: false });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: false });

    window.removeEventListener(ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT, listener);
  });
});

describe('background dev-server setting', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('defaults to enabled when the preference cannot be read', async () => {
    invokeMock.mockRejectedValueOnce(new Error('unavailable'));

    await expect(getKeepDevServersRunning()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('get_keep_dev_servers_running');
  });

  it('persists the preference and notifies this window', async () => {
    const listener = vi.fn();
    window.addEventListener(KEEP_DEV_SERVERS_RUNNING_LOCAL_CHANGED_EVENT, listener);

    await setKeepDevServersRunning(true);

    expect(invokeMock).toHaveBeenCalledWith('set_keep_dev_servers_running', { enabled: true });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: true });

    window.removeEventListener(KEEP_DEV_SERVERS_RUNNING_LOCAL_CHANGED_EVENT, listener);
  });
});
