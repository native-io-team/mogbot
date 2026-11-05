import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsMenu } from './SettingsMenu';

// The shipped brand.json: no issue reports, and the changelog starts empty, so
// Settings would be the menu's only item.
describe('SettingsMenu with only Settings to offer', () => {
  it('opens Settings from the trigger instead of a one-item menu', () => {
    const onOpenSettings = vi.fn();
    render(
      <SettingsMenu
        onOpenSettings={onOpenSettings}
        onOpenBugReports={vi.fn()}
        onOpenFeatureRequest={vi.fn()}
        onOpenChangelog={vi.fn()}
        renderTrigger={(props) => (
          <button type="button" {...props}>
            Settings
          </button>
        )}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Settings' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
