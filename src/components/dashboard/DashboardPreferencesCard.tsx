/**
 * DashboardPreferencesCard — dashboard sidebar shortcuts for settings and updates.
 *
 * @module components/DashboardPreferencesCard
 */

import { SettingsIcon } from '@/components/icons';
import { MenuButton } from '../primitives/MenuButton';
import { SETTINGS_ONLY, SettingsMenu } from '../SettingsMenu';
import { DashboardCardDisclosure } from './DashboardCardDisclosure';

interface DashboardPreferencesCardProps {
  onOpenSettings: () => void;
  onOpenBugReports: () => void;
  onOpenFeatureRequest: () => void;
  onOpenChangelog: () => void;
}

/**
 * Renders dashboard preference shortcuts and records their click events.
 * @param props - Callbacks that open settings and changelog surfaces.
 */
export function DashboardPreferencesCard({
  onOpenSettings,
  onOpenBugReports,
  onOpenFeatureRequest,
  onOpenChangelog,
}: DashboardPreferencesCardProps) {
  return (
    <DashboardCardDisclosure
      storageKey="shipstudio.dashboard.preferencesExpanded"
      defaultExpanded
      title="Preferences"
      subtitle={
        <p className="dashboard-card-subtitle text-style-body-medium">
          {SETTINGS_ONLY ? 'App settings.' : 'App settings, feedback, and release notes.'}
        </p>
      }
    >
      <div className="dashboard-card-rows">
        <SettingsMenu
          onOpenSettings={onOpenSettings}
          onOpenBugReports={onOpenBugReports}
          onOpenFeatureRequest={onOpenFeatureRequest}
          onOpenChangelog={onOpenChangelog}
          renderTrigger={(props) => (
            <MenuButton
              variant="default"
              width="fill"
              className="dashboard-card-row"
              data-education-id="settings-button"
              data-settings-menu-trigger="dashboard"
              title="Settings & Help"
              aria-label="Settings & Help"
              expanded={props['aria-expanded']}
              {...props}
            >
              <div className="dashboard-card-row-icon">
                <SettingsIcon size={18} />
              </div>
              <div className="dashboard-card-row-main">
                <div className="dashboard-card-row-name text-style-body-medium">
                  Settings &amp; Help
                </div>
                <div className="dashboard-card-row-status text-style-control">
                  {SETTINGS_ONLY
                    ? 'Theme, accent, projects folder and more'
                    : 'App settings, bug reports, feature requests, and updates'}
                </div>
              </div>
            </MenuButton>
          )}
        />
      </div>
    </DashboardCardDisclosure>
  );
}
