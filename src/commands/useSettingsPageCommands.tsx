import { useEffect } from 'react';
import { SettingsIcon } from '@/components/icons';
import { kbd } from '../lib/shortcuts';
import { menuOwnsShortcuts, onMenuAction } from '../lib/nativeMenu';
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
  // ⌘, opens Settings: the menu bar's Settings… on macOS, a key elsewhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (menuOwnsShortcuts() || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key !== ',' || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      openModal('settings');
    };
    window.addEventListener('keydown', onKeyDown);
    const offMenu = onMenuAction((action) => {
      if (action === 'settings') openModal('settings');
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      offMenu();
    };
  }, [openModal]);
  useCommands(
    () => [
      {
        id: 'settings.open',
        title: 'Settings',
        icon: <SettingsIcon size={14} />,
        category: 'settings' as const,
        shortcut: kbd('mod', ','),
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
