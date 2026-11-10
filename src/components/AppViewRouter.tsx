/**
 * Renders the top-level application views once AppContents has assembled the
 * domain props and callbacks. Keeping the view branches here leaves App.tsx
 * focused on orchestration rather than markup.
 */

import { Suspense, lazy, useEffect, type ComponentProps, type ReactNode } from 'react';
import { AccountSelectScreen } from './accounts/AccountSelectScreen';
import type { ProjectsView } from './dashboard/ProjectsView';
import { BootLoadingScreen } from './BootLoadingScreen';
import { ThumbnailConsentModal } from './preview/ThumbnailConsentModal';
import { HomeSidebar } from './workspace/HomeSidebar';
import { CompactModeToggle } from './workspace/ModeToggle';
import { AgentsView } from './agents/AgentsView';
import { WorkspaceNavigation, WorkspaceTitlebar } from './workspace/WorkspaceHeader';
import { WorkspaceSidebar } from './workspace/WorkspaceSidebar';
import type { WorkspaceView } from './workspace/WorkspaceView';
import { Spinner } from './primitives/Spinner';
import { AreaBoundary } from './primitives/AreaBoundary';
import type { Project, WorkspaceInfo } from '../lib/project';
import type { AppView } from '../lib/types';
import type { AgentPreviewServer } from '../lib/agentPreview';
import type { WorkspacePick } from './dashboard/MonorepoPickerModal';

// Agents is where the app opens, so what it doesn't need to paint (the
// workspace with its terminals and editor, the projects dashboard, onboarding)
// is its own chunk, fetched when a view first asks for it and
// warmed shortly after launch so the first switch doesn't wait.
const loadProjectsView = () => import('./dashboard/ProjectsView');
const loadMonorepoPicker = () => import('./dashboard/MonorepoPickerModal');
const loadOnboarding = () => import('./setup');
const loadWorkspaceView = () => import('./workspace/WorkspaceView');
const LazyProjectsView = lazy(() => loadProjectsView().then((m) => ({ default: m.ProjectsView })));
const LazyMonorepoPicker = lazy(() =>
  loadMonorepoPicker().then((m) => ({ default: m.MonorepoPickerModal }))
);
const LazyOnboardingRouter = lazy(() =>
  loadOnboarding().then((m) => ({ default: m.OnboardingRouter }))
);
const LazyWorkspaceView = lazy(() =>
  loadWorkspaceView().then((m) => ({ default: m.WorkspaceView }))
);

const WARM_AFTER_MS = 4000;
function useWarmViewChunks(view: AppView) {
  useEffect(() => {
    if (view === 'loading' || view === 'onboarding') return;
    const id = window.setTimeout(() => {
      void loadProjectsView();
      void loadWorkspaceView();
    }, WARM_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [view]);
}

const viewFallback = (
  <div className="app loading">
    <Spinner size="lg" />
  </div>
);

type AccountSelectProps = ComponentProps<typeof AccountSelectScreen>;
type HomeSidebarProps = Omit<ComponentProps<typeof HomeSidebar>, 'activeNav'>;
type ProjectsViewProps = ComponentProps<typeof ProjectsView>;
type WorkspaceViewProps = ComponentProps<typeof WorkspaceView>;
type ThumbnailConsentProps = ComponentProps<typeof ThumbnailConsentModal>;

interface PendingMonorepoPick {
  project: Project;
  workspaces: WorkspaceInfo[];
  selectedPick: WorkspacePick | null;
}

export interface AppViewRouterProps {
  view: AppView;
  isCompact: boolean;
  compactWorkspaceToolbarEnabled: boolean;
  bootProgress: ComponentProps<typeof BootLoadingScreen>['progress'];
  onOnboardingComplete: () => void;
  accountSelectProps: AccountSelectProps;
  homeSidebarProps: HomeSidebarProps;
  projectsViewProps: ProjectsViewProps;
  workspaceViewProps: Omit<WorkspaceViewProps, 'currentProject'> & {
    currentProject: Project | null;
  };
  currentProject: Project | null;
  pendingMonorepoPick: PendingMonorepoPick | null;
  onSelectMonorepoPick: (pick: WorkspacePick) => void;
  onConfirmMonorepoPick: () => void;
  onCancelMonorepoPick: () => void;
  thumbnailConsentProps: ThumbnailConsentProps;
  quitConfirmModal: ReactNode;
  /** The window's dev servers, for the Agents preview pane. */
  agentPreviewServer?: AgentPreviewServer;
}

const EMPTY_TAB_TITLES = new Map<number, string>();
const EMPTY_ATTENTION_TABS = new Set<number>();
const noop = () => {};

export function AppViewRouter({
  view,
  isCompact,
  compactWorkspaceToolbarEnabled,
  bootProgress,
  onOnboardingComplete,
  accountSelectProps,
  homeSidebarProps,
  projectsViewProps,
  workspaceViewProps,
  currentProject,
  pendingMonorepoPick,
  onSelectMonorepoPick,
  onConfirmMonorepoPick,
  onCancelMonorepoPick,
  thumbnailConsentProps,
  quitConfirmModal,
  agentPreviewServer,
}: AppViewRouterProps) {
  useWarmViewChunks(view);
  if (view === 'loading') {
    return (
      <>
        <BootLoadingScreen progress={bootProgress} />
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'onboarding') {
    return (
      <>
        <div className="app">
          <Suspense fallback={null}>
            <LazyOnboardingRouter onComplete={onOnboardingComplete} />
          </Suspense>
        </div>
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'account-select') {
    return (
      <>
        <div className="app">
          <AccountSelectScreen {...accountSelectProps} />
        </div>
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'projects') {
    return (
      <>
        <div className="app workspace workspace-home">
          <div
            className={`projects-with-rail${isCompact ? ' is-compact' : ''}`}
            key="view-projects"
          >
            {/* The sidebar and the projects in their own boundaries: one that
                throws leaves the other (and the way back to Agents) working. */}
            {isCompact ? (
              <CompactModeToggle mode="projects" onAgents={homeSidebarProps.onGoAgents} floating />
            ) : (
              <AreaBoundary where="projects:sidebar">
                <HomeSidebar {...homeSidebarProps} activeNav="home" />
              </AreaBoundary>
            )}
            <AreaBoundary where="projects:list">
              <Suspense fallback={null}>
                <LazyProjectsView {...projectsViewProps} />
              </Suspense>
            </AreaBoundary>
          </div>
        </div>
        {pendingMonorepoPick && (
          <Suspense fallback={null}>
            <LazyMonorepoPicker
              projectName={pendingMonorepoPick.project.name}
              workspaces={pendingMonorepoPick.workspaces}
              selectedPick={pendingMonorepoPick.selectedPick}
              onSelect={onSelectMonorepoPick}
              onConfirm={onConfirmMonorepoPick}
              onCancel={onCancelMonorepoPick}
            />
          </Suspense>
        )}
        {quitConfirmModal}
      </>
    );
  }

  // Agents takes over the whole window: its own sidebar is the agent list.
  if (view === 'agents') {
    return (
      <>
        <AgentsView
          isCompact={isCompact}
          sidebarProps={homeSidebarProps}
          previewServer={agentPreviewServer}
        />
        {quitConfirmModal}
      </>
    );
  }

  if (view === 'project-loading') {
    const showCompactWorkspaceTitlebar = !isCompact && compactWorkspaceToolbarEnabled;
    return (
      <>
        <div
          className={`app workspace workspace-home${
            showCompactWorkspaceTitlebar ? ' has-workspace-titlebar workspace--compact-toolbar' : ''
          }`}
        >
          {showCompactWorkspaceTitlebar && (
            <WorkspaceTitlebar>
              <WorkspaceNavigation
                onGoHome={homeSidebarProps.onGoHome}
                isSidebarHidden={homeSidebarProps.isSidebarHidden}
                onToggleSidebar={homeSidebarProps.onToggleSidebar}
              />
            </WorkspaceTitlebar>
          )}
          <div className="projects-with-rail" key="view-project-loading">
            <WorkspaceSidebar
              {...homeSidebarProps}
              key="sidebar-project-loading"
              isHomeActive={false}
              showNavigationControls={!compactWorkspaceToolbarEnabled}
              currentProjectPath={currentProject?.path ?? null}
              currentProjectName={currentProject?.name ?? null}
              terminalTabs={[]}
              activeTerminalTab={0}
              tabTitles={EMPTY_TAB_TITLES}
              attentionTabs={EMPTY_ATTENTION_TABS}
              maxTabs={5}
              onSelectTab={noop}
              onAddTab={noop}
              onCloseTab={noop}
              hasDevServer={false}
              isRestartingDevServer={false}
              devServerRunning={false}
            />
            <div className="project-loading-body">
              <Spinner size="lg" />
              <p>Opening {currentProject?.name}...</p>
            </div>
          </div>
        </div>
        {quitConfirmModal}
      </>
    );
  }

  const project = workspaceViewProps.currentProject;
  if (!project) {
    return (
      <>
        <div className="app loading">
          <Spinner size="lg" />
        </div>
        {quitConfirmModal}
      </>
    );
  }

  return (
    <>
      <Suspense fallback={viewFallback}>
        <LazyWorkspaceView {...workspaceViewProps} currentProject={project} />
      </Suspense>
      <ThumbnailConsentModal {...thumbnailConsentProps} />
      {quitConfirmModal}
    </>
  );
}
