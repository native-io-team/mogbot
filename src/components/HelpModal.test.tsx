import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAgentSkills } from '../lib/claude';
import { HelpModal } from './HelpModal';

vi.mock('../lib/claude', () => ({
  listAgentSkills: vi.fn(),
}));

vi.mock('../lib/agentsDesktop', () => ({
  getDesktopSettings: vi.fn().mockResolvedValue({
    supported: true,
    menuBarIcon: true,
    quickEntry: true,
    shortcut: 'Ctrl+Alt+KeyM',
    shortcutLabel: '⌃⌥M',
  }),
}));

vi.mock('../lib/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../contexts/ModalContext', () => ({
  useModal: () => ({ isOpen: true, close: vi.fn() }),
}));

describe('HelpModal', () => {
  beforeEach(() => {
    vi.mocked(listAgentSkills).mockResolvedValue([]);
  });

  it('opens on Shortcuts and preserves the current commands in a second tab', async () => {
    render(<HelpModal />);

    await waitFor(() => expect(listAgentSkills).toHaveBeenCalled());

    const shortcutsTab = screen.getByRole('tab', { name: 'Shortcuts' });
    const commandsTab = screen.getByRole('tab', { name: 'Commands' });

    expect(shortcutsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Open command palette')).toBeVisible();
    expect(screen.getByText('⌘K')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('F1')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.queryByText('Switch terminal tab')).not.toBeInTheDocument();
    expect(screen.getByText('Go to 1–9')).toBeVisible();
    expect(screen.getByText('⌘1–9')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Settings')).toBeVisible();
    expect(screen.getByText('⌘,')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘T')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘W')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Switch workspace')).toBeVisible();
    expect(screen.getByText('⌥1–9')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Toggle Session panel')).toBeVisible();
    expect(screen.getByText('Switch workspace mode')).toBeVisible();
    expect(screen.getByText('⌘⌃1–3')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Switch session or terminal tab')).toBeVisible();
    expect(screen.getByText('⌃1–9')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Toggle Edit mode')).toBeVisible();
    expect(screen.getByText('⌘E')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Toggle Inspector')).toBeVisible();
    expect(screen.getByText('⌘I')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Copy selected element')).toBeVisible();
    expect(screen.getByText('⌘C')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘X')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘V')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Duplicate selected element')).toBeVisible();
    expect(screen.getByText('⌘D')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌫')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.queryByText('/clear')).not.toBeVisible();

    fireEvent.click(commandsTab);

    expect(commandsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('/clear')).toBeVisible();
    expect(screen.getByText('Open command palette')).not.toBeVisible();
  });

  it('lists the Agents shortcuts first, with the quick-message key as the user set it', async () => {
    render(<HelpModal />);
    await screen.findByText('Quick message');
    const titles = [...document.querySelectorAll('.help-section-title')].map((t) => t.textContent);
    expect(titles.slice(0, 3)).toEqual(['Agents', 'Anywhere', 'Projects & workspace']);
    expect(screen.getByText('New agent')).toBeVisible();
    expect(screen.getByText('⌘N')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘⇧N')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘[')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘]')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('Next agent that needs your OK')).toBeVisible();
    expect(screen.getByText('⌘J')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘F')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌘⇧A')).toHaveClass('workspace-sidebar-filter-shortcut');
    expect(screen.getByText('⌃⌥M')).toHaveClass('workspace-sidebar-filter-shortcut');
  });
});
