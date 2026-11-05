import type { ReactNode } from 'react';
import { BugReportIcon, HistoryIcon, PlusIcon, SettingsIcon } from '@/components/icons';
import { Dropdown, DropdownItem } from './primitives/Dropdown';
import type { DropdownTriggerProps } from './primitives/Dropdown';
import { ISSUE_REPORTS_ENABLED } from '../lib/issueReports';
import { HAS_CHANGELOG } from './dashboard/Changelog';

interface SettingsMenuProps {
  onOpenSettings: () => void;
  onOpenBugReports: () => void;
  onOpenFeatureRequest: () => void;
  onOpenChangelog: () => void;
  renderTrigger: (props: DropdownTriggerProps) => ReactNode;
  className?: string;
  presentation?: 'dropdown' | 'drawer';
  onOpenChange?: (open: boolean) => void;
}

/** Shared app-level menu for settings, feedback, and release notes. */
export function SettingsMenu({
  onOpenSettings,
  onOpenBugReports,
  onOpenFeatureRequest,
  onOpenChangelog,
  renderTrigger,
  className,
  presentation = 'dropdown',
  onOpenChange,
}: SettingsMenuProps) {
  return (
    <Dropdown
      className={className}
      portal={presentation === 'dropdown'}
      align={presentation === 'drawer' ? 'right' : 'left'}
      side="top"
      menuClassName="settings-menu"
      trigger={renderTrigger}
      onOpenChange={onOpenChange}
    >
      <DropdownItem icon={<SettingsIcon size={14} />} onSelect={onOpenSettings}>
        <span data-settings-item="app-settings">App settings</span>
      </DropdownItem>
      {ISSUE_REPORTS_ENABLED && (
        <DropdownItem icon={<BugReportIcon size={14} />} onSelect={onOpenBugReports}>
          <span data-settings-item="bug-reports">Report a bug</span>
        </DropdownItem>
      )}
      {ISSUE_REPORTS_ENABLED && (
        <DropdownItem icon={<PlusIcon size={14} />} onSelect={onOpenFeatureRequest}>
          <span data-settings-item="feature-request">Request a feature</span>
        </DropdownItem>
      )}
      {HAS_CHANGELOG && (
        <DropdownItem icon={<HistoryIcon size={14} />} onSelect={onOpenChangelog}>
          <span data-settings-item="whats-new">What's new</span>
        </DropdownItem>
      )}
    </Dropdown>
  );
}
