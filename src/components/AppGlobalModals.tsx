import { HelpModal } from './HelpModal';
import { useAppAccent } from '../lib/accent';
import { ChangelogModal } from './dashboard/ChangelogModal';
import { AttachedLibrariesModal } from './dashboard/AttachedLibrariesModal';
import { SettingsModal } from './dashboard/SettingsModal';
import { MigrationModals } from './migration/MigrationModals';
import { RemoteAccessModal } from './remote/RemoteAccessModal';
import { PhoneModal } from './phone/PhoneModal';
import { ProjectToolsModal } from './setup/ProjectToolsModal';
import { useProjectToolsNeededListener } from '../lib/projectTools';
import { useCompanionInstallReminder } from './phone/PhoneInstallEntry';
import { ToastList } from './primitives/ToastList';
import { useModal } from '../contexts/ModalContext';
import { usePaletteContext } from './CommandPalette/paletteContext';
import { useToast } from '../contexts/ToastContext';
import { IssueReportModals } from './issue-reports/IssueReportModals';

/**
 * Globally-mounted modals that palette commands can open from any view.
 *
 * HelpModal and ChangelogModal were previously mounted inside view-specific
 * components (WorkspaceModals / ProjectList). That meant opening them via
 * `useModal('help').open()` from the home view (for example via the
 * command palette) was a no-op — the consumer wasn't in the tree. Mounting
 * them once at the app level fixes that while preserving each modal's
 * own state (via `useModal`).
 *
 * It also draws the window's one toast stack. Toasts used to be drawn by each
 * view (Agents, Projects, the workspace) *and* here, from a second provider of
 * its own: two stacks, fixed to the same corner, so a toast from Settings and
 * one from the chat landed on top of each other. One provider (App's), one
 * list, here, whatever the view.
 */
export function AppGlobalModals() {
  // Window-wide, mounted once per window: keep <html>'s accent equal to the
  // Chief of Staff's colour (lives here to keep App.tsx under its LOC limit).
  useAppAccent();
  const ctx = usePaletteContext();
  // An agent asked for a project and this Mac can't make one yet.
  useProjectToolsNeededListener();
  const changelog = useModal('changelog');
  const attachedLibraries = useModal('attachedLibraries');
  const settings = useModal('settings');
  const remoteAccess = useModal('remoteAccess');
  const phone = useModal('phone');
  const projectTools = useModal('projectTools');
  const { toasts, dismissToast, holdToast } = useToast();
  useCompanionInstallReminder();

  return (
    <>
      <HelpModal projectPath={ctx.currentProjectPath ?? undefined} />
      <ChangelogModal isOpen={changelog.isOpen} onClose={changelog.close} />
      <AttachedLibrariesModal isOpen={attachedLibraries.isOpen} onClose={attachedLibraries.close} />
      <SettingsModal isOpen={settings.isOpen} onClose={settings.close} />
      <RemoteAccessModal isOpen={remoteAccess.isOpen} onClose={remoteAccess.close} />
      <PhoneModal isOpen={phone.isOpen} onClose={phone.close} />
      <ProjectToolsModal isOpen={projectTools.isOpen} onClose={projectTools.close} />
      <IssueReportModals />
      <MigrationModals />
      <ToastList toasts={toasts} onDismiss={dismissToast} onHold={holdToast} />
    </>
  );
}
