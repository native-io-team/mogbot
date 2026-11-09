import { SettingsIcon } from '@/components/icons';
import { useOpenModal } from '../contexts/ModalContext';
import { requestSettingsTabOnOpen } from '../lib/settings';
import { SETTINGS_PAGES } from '../lib/settingsPages';
import { useCommands } from './useCommands';

/**
 * Every page of the Settings window, from the palette: "Settings → Phone"
 * opens the window on that page (`lib/settingsPages.ts`). The more exact
 * commands ("Quiet hours…", "Independence…") land on a part of a page.
 */
export function useSettingsPageCommands() {
  const openModal = useOpenModal();
  useCommands(
    () => [
      {
        id: 'settings.open',
        title: 'Settings',
        icon: <SettingsIcon size={14} />,
        category: 'settings' as const,
        keywords: ['preferences', 'options', 'configure'],
        run: () => openModal('settings'),
      },
      ...SETTINGS_PAGES.map((page) => ({
        id: `settings.page.${page.id}`,
        title: `Settings → ${page.title}`,
        icon: <SettingsIcon size={14} />,
        category: 'settings' as const,
        keywords: ['settings', 'preferences', page.title.toLowerCase(), ...page.keywords],
        run: () => {
          requestSettingsTabOnOpen(page.id);
          openModal('settings');
        },
      })),
    ],
    [openModal]
  );
}
