/**
 * Settings → Appearance → Theme: System / Light / Dark.
 *
 * The choice repaints at once (every open window follows, see lib/theme.ts)
 * and is then saved to the app settings. System follows the macOS appearance
 * live, including an automatic light/dark schedule.
 *
 * @module components/dashboard/ThemeSetting
 */

import { SegmentedControl } from '../primitives/SegmentedControl';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  setThemePreference,
  THEME_LABELS,
  THEME_PREFERENCES,
  useThemePreference,
} from '../../lib/theme';
import { YOUR_COMPUTER } from '../../lib/computer';

const OPTIONS = THEME_PREFERENCES.map((value) => ({ value, label: THEME_LABELS[value] }));

export function ThemeSetting() {
  const { showToast } = useOptionalToast();
  const preference = useThemePreference();

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-label">Theme</span>
        <span className="settings-row-description">
          System follows {YOUR_COMPUTER}&apos;s appearance, switching when it does.
        </span>
      </div>
      <SegmentedControl
        aria-label="Theme"
        value={preference}
        options={OPTIONS}
        onValueChange={(next) => {
          setThemePreference(next).catch(() => {
            showToast("Couldn't save the theme", 'error');
          });
        }}
      />
    </div>
  );
}
