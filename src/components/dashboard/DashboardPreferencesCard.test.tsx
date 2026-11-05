import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardPreferencesCard } from './DashboardPreferencesCard';

// Features brand.json can switch off are tested switched on.
vi.mock('../../lib/brand', async (importOriginal) => {
  const { withAllLinks } = await import('../../test/brandFixture');
  return withAllLinks(await importOriginal<typeof import('../../lib/brand')>());
});

describe('DashboardPreferencesCard settings menu', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('uses the shared Settings & Help label and routes Report Bug from Preferences', async () => {
    const onOpenBugReports = vi.fn();
    const user = userEvent.setup();

    render(
      <DashboardPreferencesCard
        onOpenSettings={vi.fn()}
        onOpenBugReports={onOpenBugReports}
        onOpenFeatureRequest={vi.fn()}
        onOpenChangelog={vi.fn()}
      />
    );

    const trigger = screen.getByRole('button', { name: 'Settings & Help' });
    expect(trigger).toHaveAttribute('title', 'Settings & Help');
    expect(trigger).toHaveAttribute('data-settings-menu-trigger', 'dashboard');
    expect(trigger.querySelector('.workspace-switcher-chevron')).not.toBeInTheDocument();
    await user.click(trigger);

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'App Settings' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Report Bug' }));

    await waitFor(() => expect(onOpenBugReports).toHaveBeenCalledOnce());
  });
});
