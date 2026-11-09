/**
 * Each of Settings' General, Projects and Appearance tabs is its own area: a
 * part that throws in one shows a line there, and the tab list (and the
 * other tabs) keep working.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { SettingsModal } from './SettingsModal';
import { ModalProvider } from '../../contexts/ModalContext';

vi.mock('../agents/AgentsSettings', () => ({ AgentsSettings: () => <p>agents tab</p> }));
vi.mock('./ThemeSetting', () => ({
  ThemeSetting: () => {
    throw new Error('theme broke');
  },
}));

afterEach(() => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
});

describe('Settings tabs', () => {
  it('a broken Appearance part is one line; the other tabs still open', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockIPC(() => null);
    render(
      <ModalProvider>
        <SettingsModal isOpen onClose={() => {}} />
      </ModalProvider>
    );
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Appearance' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByText('This part couldn’t be shown. Nothing was lost.')).toBeTruthy();
    expect(screen.queryByText('This dialog couldn’t be shown. Nothing was changed.')).toBeNull();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'General' }));
    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(screen.getByText('Usage analytics & error reports')).toBeTruthy();
  });
});
