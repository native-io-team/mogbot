import { describe, expect, it, vi } from 'vitest';
import { menuNumber, menuOwnsShortcuts, onMenuAction, runMenuAction } from './nativeMenu';
import { windowTitleFor } from '../hooks/useNativeMenu';

describe('nativeMenu', () => {
  it('reads the number off a numbered item, and only its own prefix', () => {
    expect(menuNumber('go_to_3', 'go_to')).toBe(3);
    expect(menuNumber('switch_workspace_mode_2', 'switch_workspace_mode')).toBe(2);
    // `switch_workspace` must not claim the mode items.
    expect(menuNumber('switch_workspace_mode_2', 'switch_workspace')).toBeNull();
    expect(menuNumber('go_to_0', 'go_to')).toBeNull();
    expect(menuNumber('go_to_10', 'go_to')).toBeNull();
    expect(menuNumber('settings', 'go_to')).toBeNull();
  });

  it('runs a menu item from the page through the same handlers, until unsubscribed', () => {
    const heard = vi.fn();
    const off = onMenuAction(heard);
    runMenuAction('toggle_edit_mode');
    expect(heard).toHaveBeenCalledWith('toggle_edit_mode');
    off();
    runMenuAction('toggle_edit_mode');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('leaves keys to the page outside the real app (tests, the UI harness)', () => {
    expect(menuOwnsShortcuts()).toBe(false);
  });

  it('names a window for what it shows', () => {
    expect(windowTitleFor('agents', 'acme')).toBe('Agents');
    expect(windowTitleFor('projects', null)).toBe('Projects');
    expect(windowTitleFor('workspace', 'acme-site')).toBe('acme-site');
    expect(windowTitleFor('workspace', null)).not.toBe('');
  });
});
