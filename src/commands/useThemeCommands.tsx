import { ContrastIcon } from '@/components/icons';
import { useOpenModal } from '../contexts/ModalContext';
import { useOptionalToast } from '../contexts/ToastContext';
import { requestSettingsTabOnOpen } from '../lib/settings';
import {
  setThemePreference,
  THEME_LABELS,
  THEME_PREFERENCES,
  useThemePreference,
  type ThemePreference,
} from '../lib/theme';
import { useCommands } from './useCommands';

const TITLES: Record<ThemePreference, string> = {
  system: 'Match system appearance',
  light: 'Use light theme',
  dark: 'Use dark theme',
};

/** Settings → Appearance → Theme, from the palette: the picker, and each choice directly. */
export function useThemeCommands() {
  const openModal = useOpenModal();
  const { showToast } = useOptionalToast();
  const current = useThemePreference();

  useCommands(
    () => [
      {
        id: 'settings.theme',
        title: 'Theme…',
        subtitle: THEME_LABELS[current],
        icon: <ContrastIcon size={14} />,
        category: 'settings',
        keywords: ['theme', 'appearance', 'light', 'dark', 'mode', 'system'],
        run: () => {
          requestSettingsTabOnOpen('appearance');
          openModal('settings');
        },
      },
      ...THEME_PREFERENCES.filter((pref) => pref !== current).map((pref) => ({
        id: `settings.theme.${pref}`,
        title: TITLES[pref],
        icon: <ContrastIcon size={14} />,
        category: 'settings' as const,
        keywords: ['theme', 'appearance', pref, 'mode'],
        run: () => {
          setThemePreference(pref).catch(() => {
            showToast("Couldn't save the theme", 'error');
          });
        },
      })),
    ],
    [current, openModal, showToast]
  );
}
