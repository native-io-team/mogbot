/**
 * Palette entries for the site-migration surfaces.
 *
 * Registered here rather than left to a toolbar button because the palette is
 * the app's own inventory of what it can do — and because the UI harness
 * sweeps that registry to screenshot every feature, so a command is also how
 * this gets visual coverage.
 */

import { GlobeIcon, LayersIcon } from '@/components/icons';
import { useCommands } from './useCommands';
import { useOpenModal } from '../contexts/ModalContext';

export function useMigrationCommands({ openCreateFromUrl }: { openCreateFromUrl: () => void }) {
  const openModal = useOpenModal();

  useCommands(
    () => [
      {
        id: 'migration.import',
        title: 'Rebuild a site from its URL…',
        subtitle: 'New Project → From a URL',
        icon: <GlobeIcon size={14} />,
        category: 'project',
        when: 'home',
        keywords: [
          'webflow',
          'framer',
          'wordpress',
          'squarespace',
          'migrate',
          'import',
          'convert',
          'url',
          'clone',
          'rebuild',
        ],
        // New Project is App state, not a ModalContext modal: opening a
        // 'newProject' id here showed nothing at all.
        run: openCreateFromUrl,
      },
      {
        id: 'migration.fidelity',
        title: 'Migration status and fidelity',
        icon: <LayersIcon size={14} />,
        category: 'project',
        keywords: [
          'migration',
          'fidelity',
          'compare',
          'diff',
          'pixel',
          'match',
          'progress',
          'status',
        ],
        run: () => openModal('migrationFidelity'),
      },
    ],
    [openModal, openCreateFromUrl]
  );
}
