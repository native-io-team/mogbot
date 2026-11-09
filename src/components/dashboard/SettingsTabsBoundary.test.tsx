/**
 * The Settings window: a section list on the left and one page at a time.
 * Each page is its own area (a part that throws shows a line there and the
 * list keeps working), it opens on the page a command asked for, and ↓/↑
 * move through the list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { SettingsModal } from './SettingsModal';
import { ModalProvider } from '../../contexts/ModalContext';
import {
  clearSettingsSectionOnOpen,
  clearSettingsTabOnOpen,
  requestSettingsSectionOnOpen,
  requestSettingsTabOnOpen,
} from '../../lib/settings';
import { SETTINGS_PAGES, openingPage } from '../../lib/settingsPages';

vi.mock('../agents/AgentsSettings', () => ({
  AgentsPage: () => <p>agents page</p>,
  IndependencePage: () => <p>independence page</p>,
  AccountsPage: () => <p>accounts page</p>,
  PhonePage: () => <p>phone page</p>,
  NotificationsPage: () => <p>notifications page</p>,
  ChromePage: () => <p>chrome page</p>,
  AppsPage: () => <p>apps page</p>,
}));
vi.mock('./ThemeSetting', () => ({
  ThemeSetting: () => {
    throw new Error('theme broke');
  },
}));

afterEach(() => {
  cleanup();
  clearMocks();
  clearSettingsTabOnOpen();
  clearSettingsSectionOnOpen();
  vi.restoreAllMocks();
});

/** Nothing set; lists come back empty, as on a fresh Mac. */
const ipc = (cmd: string) => (/accounts|workspaces/.test(cmd) ? [] : null);

const open = () =>
  render(
    <ModalProvider>
      <SettingsModal isOpen onClose={() => {}} />
    </ModalProvider>
  );

const nav = (name: string) =>
  screen
    .getByRole('navigation', { name: 'Settings sections' })
    .querySelector<HTMLElement>(
      `[data-settings-nav="${SETTINGS_PAGES.find((p) => p.title === name)!.id}"]`
    )!;

describe('Settings window', () => {
  it('lists every page and opens on Agents', () => {
    mockIPC(ipc);
    open();
    const list = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(Array.from(list.querySelectorAll('button')).map((b) => b.textContent)).toEqual(
      SETTINGS_PAGES.map((p) => p.title)
    );
    expect(nav('Agents')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 2, name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByText('agents page')).toBeInTheDocument();
  });

  it('a broken Appearance part is one line; the other pages still open', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockIPC(ipc);
    open();
    fireEvent.click(nav('Appearance'));
    expect(screen.getByText('This part couldn’t be shown. Nothing was lost.')).toBeTruthy();
    expect(screen.queryByText('This dialog couldn’t be shown. Nothing was changed.')).toBeNull();
    fireEvent.click(nav('Advanced'));
    expect(screen.getByText('Usage analytics & error reports')).toBeTruthy();
    expect(screen.getByText('Keep dev servers running')).toBeTruthy();
  });

  it('opens on the page a command asked for', () => {
    mockIPC(ipc);
    requestSettingsTabOnOpen('agents');
    requestSettingsSectionOnOpen('agent-quiet');
    open();
    expect(nav('Notifications')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('notifications page')).toBeInTheDocument();
  });

  it('↓ and ↑ move through the list', () => {
    mockIPC(ipc);
    open();
    fireEvent.keyDown(nav('Agents'), { key: 'ArrowDown' });
    expect(nav('Independence')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('independence page')).toBeInTheDocument();
    fireEvent.keyDown(nav('Independence'), { key: 'ArrowUp' });
    fireEvent.keyDown(nav('Agents'), { key: 'ArrowUp' });
    expect(nav('Advanced')).toHaveAttribute('aria-current', 'page');
  });
});

describe('openingPage', () => {
  it('a part wins over a page, accounts over the Agents default, old tabs map', () => {
    expect(openingPage({ tab: 'agents', section: 'agent-slack' })).toBe('apps');
    expect(openingPage({ tab: 'agents', accounts: true })).toBe('accounts');
    expect(openingPage({ tab: 'general' })).toBe('advanced');
    expect(openingPage({ tab: 'experimental' })).toBe('advanced');
    expect(openingPage({ tab: 'phone' })).toBe('phone');
    expect(openingPage({})).toBe('agents');
  });
});
