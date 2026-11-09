/**
 * Settings → Agents rows the Chief also changes from chat: quiet hours
 * (off, a switch; on, the switch and two times), "Slow down on battery" (on
 * by default), each read again when chat changes it; and the desk opening
 * Settings for what needs the user's own hands (Slack's masked token, an
 * account's sign-in).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, () => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, fn: () => void) => {
    tauri.handlers.set(name, fn);
    return Promise.resolve(() => tauri.handlers.delete(name));
  }),
}));

import { AgentQuietHoursSetting, DEFAULT_QUIET } from './AgentQuietHoursSetting';
import { AgentLowPowerSetting } from './AgentLowPowerSetting';
import { openSettingsFor } from '../../hooks/useOpenSettingsFromChat';
import { takeSettingsSectionRequest, peekSettingsTabOnOpen } from '../../lib/settings';
import { takeAccountsRequest } from '../../lib/agentAccounts';
import { takeAccountSignIn } from '../../lib/settingsFromChat';

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe('quiet hours on the desk', () => {
  let saved: { start: number; end: number } | null;
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.handlers.clear();
    saved = null;
    tauri.invoke.mockImplementation((cmd: string, args?: { window?: typeof saved }) => {
      if (cmd === 'agents_quiet_hours') return Promise.resolve(saved);
      if (cmd === 'agents_set_quiet_hours') {
        saved = args?.window ?? null;
        return Promise.resolve(saved);
      }
      return Promise.reject(new Error(`unmocked ${cmd}`));
    });
  });

  it('is a switch when off, and turning it on starts on a usual night', async () => {
    render(<AgentQuietHoursSetting />);
    await flush();
    expect(screen.getByText('Quiet hours')).toBeTruthy();
    expect(screen.queryByLabelText('Quiet hours start')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Quiet hours' }));
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('agents_set_quiet_hours', { window: DEFAULT_QUIET });
    expect(screen.getByDisplayValue('22:00').getAttribute('aria-label')).toBe('Quiet hours start');
    expect(screen.getByDisplayValue('07:00').getAttribute('aria-label')).toBe('Quiet hours end');
  });

  it('changes a time, never to the same start and end, and follows chat', async () => {
    saved = { start: 22 * 60, end: 7 * 60 };
    render(<AgentQuietHoursSetting />);
    await flush();
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '08:30' } });
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('agents_set_quiet_hours', {
      window: { start: 1320, end: 510 },
    });
    tauri.invoke.mockClear();
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '22:00' } });
    await flush();
    expect(tauri.invoke).not.toHaveBeenCalledWith('agents_set_quiet_hours', expect.anything());
    // The Chief turned them off from chat: the row reads again.
    saved = null;
    act(() => {
      tauri.handlers.get('agents-quiet-hours-changed')?.();
    });
    await flush();
    expect(screen.queryByLabelText('Quiet hours start')).toBeNull();
  });
});

describe('slow down on battery', () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.handlers.clear();
  });

  it('is on by default, turns off, and follows chat', async () => {
    let on = true;
    tauri.invoke.mockImplementation((cmd: string, args?: { enabled?: boolean }) => {
      if (cmd === 'get_low_power_on_battery') return Promise.resolve(on);
      if (cmd === 'set_low_power_on_battery') {
        on = !!args?.enabled;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unmocked ${cmd}`));
    });
    render(<AgentLowPowerSetting />);
    await flush();
    const toggle = screen.getByRole('switch', { name: 'Slow down on battery' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await flush();
    expect(tauri.invoke).toHaveBeenCalledWith('set_low_power_on_battery', { enabled: false });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    on = true;
    act(() => {
      tauri.handlers.get('app-settings-changed')?.();
    });
    await flush();
    expect(
      screen.getByRole('switch', { name: 'Slow down on battery' }).getAttribute('aria-checked')
    ).toBe('true');
  });
});

describe('the Chief opening Settings on the Mac', () => {
  it('opens Slack’s setup, never anything carrying a token', () => {
    const open = vi.fn();
    openSettingsFor({ section: 'slack' }, open);
    expect(open).toHaveBeenCalledOnce();
    expect(peekSettingsTabOnOpen()).toBe('agents');
    expect(takeSettingsSectionRequest('agent-slack')).toBe(true);
  });

  it('opens Accounts with the new account’s sign-in', () => {
    const open = vi.fn();
    openSettingsFor({ section: 'accounts', engine: 'claude', accountId: 'acc-9' }, open);
    expect(open).toHaveBeenCalledOnce();
    expect(takeAccountsRequest()).toBe('show');
    expect(takeAccountSignIn()).toBe('acc-9');
  });
});
