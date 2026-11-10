/**
 * Settings: a window of its own over the app, with a section list down the
 * left and one page at a time on the right (Linear's and Raycast's shape),
 * instead of every group stacked in one long scroll.
 *
 * Built on `ModalFrame`, sized to the window, rather than as an `AppView`:
 * Settings is opened from every window (Agents, Projects, a project's
 * workspace, the Chief's `open_settings`, a chat note's button) and must
 * keep the user's place under it; a dialog gives that, plus focus trapping,
 * Esc to go back and stacking under confirms, for free.
 *
 * Pages (`lib/settingsPages.ts`): Agents, Independence, Accounts & usage,
 * Phone, Notifications, Chrome, Apps (the agents' pages, in
 * `agents/AgentsSettings.tsx`), then Projects, Appearance and Advanced
 * (analytics and the experimental switches). It opens on the page a command
 * asked for (a part of a page, the accounts area, or a page by name), else
 * Agents. ↑/↓ move through the list.
 *
 * @module components/SettingsModal
 */

import { getSnapshot } from '../../commands/registry';
import { useState, useEffect, useCallback } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import {
  AccountsPage,
  AgentsPage,
  AppsPage,
  ChromePage,
  IndependencePage,
  NotificationsPage,
  PhonePage,
} from '../agents/AgentsSettings';
import { AccentColorSetting } from './AccentColorSetting';
import { ThemeSetting } from './ThemeSetting';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Group, Row, Toggle } from '../agents/AgentSettingsRows';
import { AreaBoundary } from '../primitives/AreaBoundary';
import { getAnalyticsEnabled, setAnalyticsEnabled, trackEvent } from '../../lib/analytics';
import { useOptionalToast } from '../../contexts/ToastContext';
import {
  DASHBOARD_VISIBILITY_CHANGED_EVENT,
  type DashboardVisibilityChangedDetail,
  getSlackCtaHidden,
  setSlackCtaHidden,
  getTerminalGpuEnabled,
  setTerminalGpuEnabled,
  getCompactWorkspaceToolbarEnabled,
  setCompactWorkspaceToolbarEnabled,
  getCommitAttributionEnabled,
  getElementBreadcrumbEnabled,
  getTeamSharingEnabled,
  setCommitAttributionEnabled,
  setElementBreadcrumbEnabled,
  setTeamSharingEnabled,
  ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT,
  getThumbnailsEnabled,
  setThumbnailsEnabled,
  getSpotifyWidgetEnabled,
  setSpotifyWidgetEnabled,
  setKeepDevServersRunning,
  SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT,
  getProjectsRoot,
  isCustomProjectsRoot,
  pickProjectsRoot,
  setProjectsRoot,
  listMovableProjects,
  moveProjectsToRoot,
  type MovableProjects,
  peekSettingsTabOnOpen,
  clearSettingsTabOnOpen,
  peekSettingsSectionOnOpen,
  clearSettingsSectionOnOpen,
} from '../../lib/settings';
import { peekAccountsRequest } from '../../lib/agentAccounts';
import { onAppSettingsChanged } from '../../lib/settingsFromChat';
import {
  SETTINGS_PAGES,
  openingPage,
  settingsPageInfo,
  type SettingsPage,
} from '../../lib/settingsPages';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { isMac } from '../../lib/setup';
import { MoveToFolderIcon } from '@/components/icons';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { useOpenModal } from '../../contexts/ModalContext';
import { useKeepDevServersRunning } from '../../hooks/useKeepDevServersRunning';
import { BRAND } from '../../lib/brand';
import { SLACK_INVITE_URL } from '../../lib/links';

const errMsg = (err: unknown) => formatCommandError(asCommandError(err));

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSlackCtaHiddenChange?: (hidden: boolean) => void;
  /** Called after the projects folder changes (and after a move) so the
   *  dashboard can re-list projects. */
  onProjectsRootChanged?: () => void;
}

/** Pending "move existing projects?" prompt state. */
interface MovePrompt {
  from: string;
  to: string;
  info: MovableProjects;
}

/** The section list: one button per page, the open one marked as the current page. */
function SettingsNav({
  page,
  onPage,
}: {
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
}) {
  const move = (event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const i = SETTINGS_PAGES.findIndex((p) => p.id === page);
    const next = SETTINGS_PAGES[(i + step + SETTINGS_PAGES.length) % SETTINGS_PAGES.length];
    onPage(next.id);
    event.currentTarget
      .querySelector<HTMLElement>(`[data-settings-nav="${next.id}"]`)
      ?.focus({ preventScroll: true });
  };
  return (
    <nav className="settings-window__nav" aria-label="Settings sections" onKeyDown={move}>
      {SETTINGS_PAGES.map((p, i) => (
        <span key={p.id} className="settings-window__nav-entry">
          {/* Agents' pages first, then the app's: one hairline between. */}
          {p.id === 'projects' && i > 0 && (
            <span className="settings-window__nav-divider" aria-hidden="true" />
          )}
          <Button
            variant="ghost"
            width="fill"
            className="settings-window__nav-item"
            data-settings-nav={p.id}
            aria-current={p.id === page ? 'page' : undefined}
            data-selected={p.id === page || undefined}
            onClick={() => onPage(p.id)}
          >
            {p.title}
          </Button>
        </span>
      ))}
    </nav>
  );
}

export function SettingsModal({
  isOpen,
  onClose,
  onSlackCtaHiddenChange,
  onProjectsRootChanged,
}: SettingsModalProps) {
  const { showToast } = useOptionalToast();
  const openModal = useOpenModal();
  // Projects folder is per-workspace; reflect the active one in the label.
  const { activeAccount, accounts } = useActiveAccount();
  const multipleWorkspaces = accounts.length > 1;
  const keepDevServersRunning = useKeepDevServersRunning() ?? true;

  const [analyticsEnabled, setLocalAnalyticsEnabled] = useState(true);
  const [slackCtaVisible, setLocalSlackCtaVisible] = useState(true);
  const [terminalGpuEnabled, setLocalTerminalGpuEnabled] = useState(true);
  const [compactWorkspaceToolbarEnabled, setLocalCompactWorkspaceToolbarEnabled] = useState(false);
  const [elementBreadcrumbEnabled, setLocalElementBreadcrumbEnabled] = useState(true);
  const [commitAttributionEnabled, setLocalCommitAttributionEnabled] = useState(true);
  const [teamSharingEnabled, setLocalTeamSharingEnabled] = useState(true);
  const [thumbnailsOn, setLocalThumbnailsOn] = useState(true);
  const [spotifyWidgetEnabled, setLocalSpotifyWidgetEnabled] = useState(false);
  const [page, setPage] = useState<SettingsPage>('agents');
  const [loading, setLoading] = useState(true);

  const [projectsRoot, setLocalProjectsRoot] = useState('');
  const [customRoot, setCustomRoot] = useState(false);
  const [savingRoot, setSavingRoot] = useState(false);
  const [movePrompt, setMovePrompt] = useState<MovePrompt | null>(null);
  const [moving, setMoving] = useState(false);
  // Bumped when the Chief changes a switch from chat, so an open page reads again.
  const [changedFromChat, setChangedFromChat] = useState(0);

  useEffect(() => {
    if (!isOpen) return;
    let off: (() => void) | undefined;
    let gone = false;
    try {
      onAppSettingsChanged(() => setChangedFromChat((n) => n + 1))
        .then((u) => (gone ? u() : (off = u)))
        .catch(() => {});
    } catch {
      /* no event bridge (tests, the harness) */
    }
    return () => {
      gone = true;
      off?.();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      const [
        enabled,
        slackHidden,
        gpuEnabled,
        compactToolbarEnabled,
        breadcrumbEnabled,
        attributionEnabled,
        sharingEnabled,
        thumbnails,
        spotifyEnabled,
        root,
        custom,
      ] = await Promise.all([
        getAnalyticsEnabled(),
        getSlackCtaHidden(),
        getTerminalGpuEnabled(),
        getCompactWorkspaceToolbarEnabled(),
        getElementBreadcrumbEnabled(),
        getCommitAttributionEnabled(),
        getTeamSharingEnabled(),
        getThumbnailsEnabled(),
        isMac() ? getSpotifyWidgetEnabled() : Promise.resolve(false),
        getProjectsRoot().catch(() => ''),
        isCustomProjectsRoot(),
      ]);
      if (!cancelled) {
        setLocalAnalyticsEnabled(enabled);
        setLocalSlackCtaVisible(!slackHidden);
        setLocalTerminalGpuEnabled(gpuEnabled);
        setLocalCompactWorkspaceToolbarEnabled(compactToolbarEnabled);
        setLocalElementBreadcrumbEnabled(breadcrumbEnabled);
        setLocalCommitAttributionEnabled(attributionEnabled);
        setLocalTeamSharingEnabled(sharingEnabled);
        // `null` = not asked yet; the toggle reflects the default-on behavior
        // (the first auto-capture will show the in-app explainer).
        setLocalThumbnailsOn(thumbnails !== false);
        setLocalSpotifyWidgetEnabled(spotifyEnabled);
        setLocalProjectsRoot(root);
        setCustomRoot(custom);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, changedFromChat]);

  // Opens on Agents, unless a command asked for a page (⌘K → "Accent color…",
  // "Quiet hours…", the Chief's open_settings). Chosen during render, not in
  // an effect: the dialog places focus on its first commit, and an
  // effect-driven switch left focus on the wrong page's controls.
  const [openedFor, setOpenedFor] = useState(false);
  if (isOpen !== openedFor) {
    setOpenedFor(isOpen);
    if (isOpen)
      setPage(
        openingPage({
          section: peekSettingsSectionOnOpen(),
          accounts: peekAccountsRequest(),
          tab: peekSettingsTabOnOpen(),
        })
      );
  }
  useEffect(() => {
    if (isOpen) return;
    clearSettingsTabOnOpen();
    // A part asked for on a page that never showed it (no engine yet) must
    // not pull the next open onto that page.
    clearSettingsSectionOnOpen();
  }, [isOpen]);

  // Keep either Settings modal instance in sync with inline home-screen hide
  // actions or changes made through the other Settings entry point.
  useEffect(() => {
    const handleVisibilityChanged = (event: Event) => {
      const detail = (event as CustomEvent<DashboardVisibilityChangedDetail>).detail;
      if (!detail) return;
      if (detail.key === 'slackCta') setLocalSlackCtaVisible(!detail.hidden);
    };

    window.addEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
    return () =>
      window.removeEventListener(DASHBOARD_VISIBILITY_CHANGED_EVENT, handleVisibilityChanged);
  }, []);

  // Keep the Appearance toggle in sync with previews and other Settings modal
  // instances that share the persisted preference.
  useEffect(() => {
    const handleElementBreadcrumbChanged = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail;
      if (typeof detail === 'boolean') setLocalElementBreadcrumbEnabled(detail);
    };

    window.addEventListener(
      ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT,
      handleElementBreadcrumbChanged
    );
    return () =>
      window.removeEventListener(
        ELEMENT_BREADCRUMB_ENABLED_CHANGED_EVENT,
        handleElementBreadcrumbChanged
      );
  }, []);

  // The sidebar (which renders the widget) isn't a child of this modal, so a
  // toggle flip elsewhere (or a second Settings instance) needs this to stay
  // in sync rather than going stale until the next open.
  useEffect(() => {
    const handleSpotifyWidgetChanged = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail;
      if (typeof detail === 'boolean') setLocalSpotifyWidgetEnabled(detail);
    };

    window.addEventListener(SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT, handleSpotifyWidgetChanged);
    return () =>
      window.removeEventListener(SPOTIFY_WIDGET_ENABLED_CHANGED_EVENT, handleSpotifyWidgetChanged);
  }, []);

  const handleToggle = useCallback(() => {
    const newValue = !analyticsEnabled;
    setLocalAnalyticsEnabled(newValue);
    void setAnalyticsEnabled(newValue);
    if (newValue) {
      // Track re-enable (this fires before the backend disables, so it gets sent)
      void trackEvent('setting_changed', {
        setting: 'analytics',
        value: true,
        $screen_name: 'Settings',
      });
    }
  }, [analyticsEnabled]);

  const handleSlackCtaToggle = useCallback(() => {
    const newVisible = !slackCtaVisible;
    setLocalSlackCtaVisible(newVisible);
    void setSlackCtaHidden(!newVisible);
    onSlackCtaHiddenChange?.(!newVisible);
  }, [slackCtaVisible, onSlackCtaHiddenChange]);

  const handleTerminalGpuToggle = useCallback(() => {
    const newEnabled = !terminalGpuEnabled;
    setLocalTerminalGpuEnabled(newEnabled);
    void setTerminalGpuEnabled(newEnabled);
    void trackEvent('setting_changed', {
      setting: 'terminal_gpu',
      value: newEnabled,
      $screen_name: 'Settings',
    });
  }, [terminalGpuEnabled]);

  const handleCompactWorkspaceToolbarToggle = useCallback(() => {
    const enabled = !compactWorkspaceToolbarEnabled;
    setLocalCompactWorkspaceToolbarEnabled(enabled);
    void setCompactWorkspaceToolbarEnabled(enabled);
    void trackEvent('setting_changed', {
      setting: 'compact_workspace_toolbar',
      value: enabled,
      $screen_name: 'Settings',
    });
  }, [compactWorkspaceToolbarEnabled]);

  const handleElementBreadcrumbToggle = useCallback(() => {
    const enabled = !elementBreadcrumbEnabled;
    setLocalElementBreadcrumbEnabled(enabled);
    void setElementBreadcrumbEnabled(enabled);
    void trackEvent('setting_changed', {
      setting: 'element_breadcrumb',
      value: enabled,
      $screen_name: 'Settings',
    });
  }, [elementBreadcrumbEnabled]);

  const handleCommitAttributionToggle = useCallback(() => {
    const enabled = !commitAttributionEnabled;
    setLocalCommitAttributionEnabled(enabled);
    void setCommitAttributionEnabled(enabled);
    void trackEvent('setting_changed', {
      setting: 'commit_attribution',
      value: enabled,
      $screen_name: 'Settings',
    });
  }, [commitAttributionEnabled]);

  const handleTeamSharingToggle = useCallback(() => {
    const enabled = !teamSharingEnabled;
    setLocalTeamSharingEnabled(enabled);
    void setTeamSharingEnabled(enabled);
    void trackEvent('setting_changed', {
      setting: 'team_sharing',
      value: enabled,
      $screen_name: 'Settings',
    });
  }, [teamSharingEnabled]);

  const handleThumbnailsToggle = useCallback(() => {
    const newEnabled = !thumbnailsOn;
    setLocalThumbnailsOn(newEnabled);
    void setThumbnailsEnabled(newEnabled);
    void trackEvent('setting_changed', {
      setting: 'thumbnails',
      value: newEnabled,
      $screen_name: 'Settings',
    });
  }, [thumbnailsOn]);

  const handleSpotifyWidgetToggle = useCallback(() => {
    const newEnabled = !spotifyWidgetEnabled;
    setLocalSpotifyWidgetEnabled(newEnabled);
    void setSpotifyWidgetEnabled(newEnabled);
    void trackEvent('setting_changed', {
      setting: 'spotify_widget',
      value: newEnabled,
      $screen_name: 'Settings',
    });
  }, [spotifyWidgetEnabled]);

  const handleKeepDevServersRunningToggle = useCallback(() => {
    const enabled = !keepDevServersRunning;
    void setKeepDevServersRunning(enabled);
    void trackEvent('setting_changed', {
      setting: 'keep_dev_servers_running',
      value: enabled,
      $screen_name: 'Settings',
    });
  }, [keepDevServersRunning]);

  // Persist a new projects root, then offer to move existing projects over.
  const applyNewRoot = useCallback(
    async (newRoot: string) => {
      const previous = projectsRoot;
      if (!newRoot || newRoot === previous) return;
      setSavingRoot(true);
      try {
        await setProjectsRoot(newRoot);
        setLocalProjectsRoot(newRoot);
        setCustomRoot(true);
        onProjectsRootChanged?.();
        void trackEvent('setting_changed', {
          setting: 'projects_root',
          value: true,
          $screen_name: 'Settings',
        });
        showToast('Projects folder updated', 'success');

        // Offer to move any projects left behind in the previous folder.
        if (previous && previous !== newRoot) {
          const info = await listMovableProjects(previous, newRoot).catch(() => null);
          if (info && (info.movable.length || info.collisions.length || info.open.length)) {
            setMovePrompt({ from: previous, to: newRoot, info });
          }
        }
      } catch (err) {
        showToast(errMsg(err), 'error');
      } finally {
        setSavingRoot(false);
      }
    },
    [projectsRoot, onProjectsRootChanged, showToast]
  );

  const handleChangeFolder = useCallback(async () => {
    try {
      const picked = await pickProjectsRoot();
      if (picked) await applyNewRoot(picked);
    } catch (err) {
      showToast(errMsg(err), 'error');
    }
  }, [applyNewRoot, showToast]);

  const handleResetFolder = useCallback(async () => {
    setSavingRoot(true);
    try {
      await setProjectsRoot('');
      const root = await getProjectsRoot();
      setLocalProjectsRoot(root);
      setCustomRoot(false);
      onProjectsRootChanged?.();
      void trackEvent('setting_changed', {
        setting: 'projects_root',
        value: false,
        $screen_name: 'Settings',
      });
      showToast('Reset to the default projects folder', 'success');
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      setSavingRoot(false);
    }
  }, [onProjectsRootChanged, showToast]);

  const handleConfirmMove = useCallback(async () => {
    if (!movePrompt) return;
    setMoving(true);
    try {
      const report = await moveProjectsToRoot(movePrompt.from, movePrompt.to);
      onProjectsRootChanged?.();
      void trackEvent('projects_moved', {
        moved_count: report.moved.length,
        skipped_count: report.skipped.length,
        $screen_name: 'Settings',
      });
      const movedMsg = `Moved ${report.moved.length} project${report.moved.length === 1 ? '' : 's'}`;
      const skipMsg = report.skipped.length ? `, skipped ${report.skipped.length}` : '';
      showToast(`${movedMsg}${skipMsg}`, report.skipped.length ? 'info' : 'success');
      setMovePrompt(null);
    } catch (err) {
      showToast(errMsg(err), 'error');
    } finally {
      setMoving(false);
    }
  }, [movePrompt, onProjectsRootChanged, showToast]);

  const pageInfo = settingsPageInfo(page);
  const agentPage = (() => {
    switch (page) {
      case 'agents':
        return (
          <AgentsPage
            onImport={() => {
              onClose();
              // The palette's own command: it opens Agents, then the import.
              void getSnapshot()
                .find((c) => c.id === 'agents.import')
                ?.run();
            }}
          />
        );
      case 'independence':
        return <IndependencePage />;
      case 'accounts':
        return <AccountsPage />;
      case 'phone':
        return <PhonePage />;
      case 'notifications':
        return <NotificationsPage />;
      case 'chrome':
        return <ChromePage />;
      case 'apps':
        return <AppsPage />;
      default:
        return null;
    }
  })();

  return (
    <>
      <ModalFrame isOpen={isOpen} onClose={onClose} title="Settings" className="settings-window">
        <div className="settings-window__layout">
          <SettingsNav page={page} onPage={setPage} />
          <div
            className="settings-window__page"
            role="region"
            aria-labelledby="settings-page-title"
            data-settings-page={page}
            // A new page starts at its top, as a new window would.
            key={page}
          >
            <header className="settings-window__page-head">
              <h2 className="settings-window__page-title" id="settings-page-title">
                {pageInfo.title}
              </h2>
              <p className="settings-window__page-lead">{pageInfo.lead}</p>
            </header>
            <AreaBoundary where={`settings:${page}`}>
              {agentPage}
              {page === 'projects' && (
                <div className="agents-settings">
                  <Group id="projects-where" title="Where projects live">
                    <div className="settings-row settings-row--stacked">
                      <div className="settings-row-info">
                        <span className="settings-row-label">
                          Projects folder
                          {multipleWorkspaces && activeAccount && (
                            <span className="settings-folder-workspace">
                              <span
                                className="settings-folder-workspace-dot"
                                style={{ backgroundColor: activeAccount.color }}
                              />
                              {activeAccount.name}
                            </span>
                          )}
                        </span>
                        <span className="settings-row-description">
                          {multipleWorkspaces && activeAccount
                            ? `Where the ${activeAccount.name} workspace lists and creates projects. Each workspace can use its own folder.`
                            : 'Where projects are listed and created. Point it at a folder you already use to keep everything in one place.'}
                        </span>
                        <button
                          type="button"
                          className="settings-folder-field"
                          onClick={() => void handleChangeFolder()}
                          disabled={savingRoot || loading}
                          title="Change projects folder"
                          aria-label="Change projects folder"
                        >
                          <span className="settings-folder-field-path">
                            {projectsRoot || '—'}
                            {!customRoot && projectsRoot ? ' (default)' : ''}
                          </span>
                          <MoveToFolderIcon size={14} />
                        </button>
                        {customRoot && (
                          <TextButton
                            className="settings-folder-reset"
                            onClick={() => void handleResetFolder()}
                            disabled={savingRoot}
                          >
                            Reset to default
                          </TextButton>
                        )}
                      </div>
                    </div>
                    <Row
                      label="Shared libraries"
                      description="Folders an agent brings to every project in this workspace: brand docs, snippets, your own skills. Claude Code only."
                    >
                      <Button
                        variant="secondary"
                        onClick={() => {
                          onClose();
                          openModal('attachedLibraries');
                        }}
                      >
                        Manage…
                      </Button>
                    </Row>
                  </Group>
                  {/* The one thing in this app that writes words into a shared
                      repository, so it says exactly what it writes and exactly
                      who reads it, in the row itself rather than in a doc. The
                      credit line sits beside it: both are what the app writes
                      into your history, a decision about your repo rather than
                      a cosmetic preference. One-shot deep settings stay out of
                      ⌘K, per the repo's own rule. */}
                  <Group id="projects-commits" title="Commits">
                    <Row
                      label="Let your agent write the commit message"
                      description="When you push, your agent writes the subject and a short paragraph on why. Never your prompts, your conversation or your terminal. It is permanent: anyone who can read the repository can read it."
                    >
                      <Toggle
                        on={teamSharingEnabled}
                        label="Let your agent write the commit message"
                        onChange={handleTeamSharingToggle}
                        disabled={loading}
                      />
                    </Row>
                    <Row
                      label="Credit the agent in commits"
                      description={
                        <>
                          A <code>Made-With</code> line at the bottom of an agent&apos;s commits,
                          naming it. A git trailer, so never in the subject or{' '}
                          <code>git log --oneline</code>.
                        </>
                      }
                    >
                      <Toggle
                        on={commitAttributionEnabled}
                        label="Credit the agent in commits"
                        onChange={handleCommitAttributionToggle}
                        disabled={loading}
                      />
                    </Row>
                  </Group>
                  <Group id="projects-previews" title="Previews and terminals">
                    <Row
                      label="Keep dev servers running"
                      description="Previews stay ready while you switch views or projects. A server stops when you stop it, close its project or quit."
                    >
                      <Toggle
                        on={keepDevServersRunning}
                        label="Keep dev servers running"
                        onChange={handleKeepDevServersRunningToggle}
                        disabled={loading}
                      />
                    </Row>
                    <Row
                      label="Project thumbnails"
                      description={`A screenshot of each preview on the Projects page. macOS may ask for Screen Recording: allow ${BRAND.name} in System Settings → Privacy & Security, then turn this back on.`}
                    >
                      <Toggle
                        on={thumbnailsOn}
                        label="Project thumbnails"
                        onChange={handleThumbnailsToggle}
                        disabled={loading}
                      />
                    </Row>
                    <Row
                      label="Terminal GPU acceleration"
                      description="Faster, smoother terminals. Turn off if output looks garbled (some macOS betas). New terminals only."
                    >
                      <Toggle
                        on={terminalGpuEnabled}
                        label="Terminal GPU acceleration"
                        onChange={handleTerminalGpuToggle}
                        disabled={loading}
                      />
                    </Row>
                  </Group>
                </div>
              )}
              {page === 'appearance' && (
                <div className="agents-settings">
                  <Group id="appearance-look" title="Look">
                    <ThemeSetting />
                    <AccentColorSetting />
                    {SLACK_INVITE_URL && (
                      <Row
                        label="Show community banner"
                        description="The Slack community invite on the Projects page."
                      >
                        <Toggle
                          on={slackCtaVisible}
                          label="Show community banner"
                          onChange={handleSlackCtaToggle}
                          disabled={loading}
                        />
                      </Row>
                    )}
                  </Group>
                  <Group id="appearance-workspace" title="Project workspace">
                    <Row
                      label="Compact toolbar"
                      description="One top bar for the workspace's controls, with Home and the sidebar in it."
                    >
                      <Toggle
                        on={compactWorkspaceToolbarEnabled}
                        label="Compact workspace toolbar"
                        onChange={handleCompactWorkspaceToolbarToggle}
                        disabled={loading}
                      />
                    </Row>
                    <Row
                      label="Element breadcrumb"
                      description="The selected element's path along the bottom of the preview."
                    >
                      <Toggle
                        on={elementBreadcrumbEnabled}
                        label="Show element breadcrumb"
                        onChange={handleElementBreadcrumbToggle}
                        disabled={loading}
                      />
                    </Row>
                  </Group>
                </div>
              )}
              {page === 'advanced' && (
                <div className="agents-settings">
                  <Group id="advanced-reports" title="Reports">
                    <Row
                      label="Usage analytics & error reports"
                      description="Anonymous usage and error reports, never your code or files. Off sends nothing."
                    >
                      <Toggle
                        on={analyticsEnabled}
                        label="Usage analytics and error reports"
                        onChange={handleToggle}
                        disabled={loading}
                      />
                    </Row>
                  </Group>
                  {isMac() && (
                    <Group id="advanced-extras" title="Extras">
                      <Row
                        label="Spotify controls"
                        description="What's playing in Spotify, in the sidebar, with play, pause and skip. macOS asks once to let the app control Spotify."
                      >
                        <Toggle
                          on={spotifyWidgetEnabled}
                          label="Spotify controls"
                          onChange={handleSpotifyWidgetToggle}
                          disabled={loading}
                        />
                      </Row>
                    </Group>
                  )}
                </div>
              )}
            </AreaBoundary>
          </div>
        </div>
      </ModalFrame>

      {movePrompt && (
        <ModalFrame
          isOpen={true}
          onClose={() => !moving && setMovePrompt(null)}
          title="Move existing projects?"
          className="settings-modal"
        >
          <div className="settings-modal-body">
            <p className="settings-move-intro">
              {movePrompt.info.movable.length > 0 ? (
                <>
                  Move{' '}
                  <strong>
                    {movePrompt.info.movable.length} project
                    {movePrompt.info.movable.length === 1 ? '' : 's'}
                  </strong>{' '}
                  from your previous folder into the new one?
                </>
              ) : (
                <>There are no projects that can be moved cleanly into the new folder.</>
              )}
            </p>
            <p className="settings-move-paths">
              <span title={movePrompt.from}>{movePrompt.from}</span>
              <span aria-hidden> → </span>
              <span title={movePrompt.to}>{movePrompt.to}</span>
            </p>
            {movePrompt.info.collisions.length > 0 && (
              <p className="settings-move-note">
                {movePrompt.info.collisions.length} skipped — a folder with the same name already
                exists in the destination.
              </p>
            )}
            {movePrompt.info.open.length > 0 && (
              <p className="settings-move-note">
                {movePrompt.info.open.length} skipped — currently open. Close them first to move.
              </p>
            )}
            <div className="settings-move-actions">
              <Button variant="ghost" onClick={() => setMovePrompt(null)} disabled={moving}>
                Not now
              </Button>
              <Button
                variant="primary"
                onClick={() => void handleConfirmMove()}
                disabled={moving || movePrompt.info.movable.length === 0}
              >
                {moving
                  ? 'Moving…'
                  : `Move ${movePrompt.info.movable.length} project${movePrompt.info.movable.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </div>
        </ModalFrame>
      )}
    </>
  );
}
