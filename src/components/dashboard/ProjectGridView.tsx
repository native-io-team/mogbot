/**
 * ProjectGridView — renders the grid of folders + project cards, or the
 * empty-state when nothing matches. Extracted from ProjectList.
 *
 * @module components/ProjectGridView
 */

import { FolderCard } from './FolderCard';
import { ProjectCard } from './ProjectCard';
import { ProjectTableView } from './ProjectTableView';
import { EmptyState } from '../primitives/EmptyState';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { useProjectToolsChecking } from '../../lib/projectTools';
import { PlusIcon } from '@/components/icons';
import type { DashboardProject } from '../../lib/project';
import type { FolderInfo } from '../../lib/folders';

interface ProjectWithThumbnail extends DashboardProject {
  thumbnailData: string | null;
}

/** Dashboard project presentation modes. */
export type ProjectViewMode = 'grid' | 'list';

/** Props for rendering projects as cards or selectable rows. */
export interface ProjectGridViewProps {
  viewMode: ProjectViewMode;
  currentFolderId: string | null;
  searchQuery: string;
  totalCount: number;
  filteredFolders: FolderInfo[];
  filteredProjects: ProjectWithThumbnail[];
  selectedProjectPaths: ReadonlySet<string>;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;

  onSelectAllVisible: (selected: boolean) => void;
  onToggleProjectSelection: (projectPath: string) => void;
  onSelectProject: (project: ProjectWithThumbnail) => void;
  onOpenProjectSettings: (project: DashboardProject) => void;
  onDeleteProject: (project: DashboardProject) => void;
  onRenameProject: (project: DashboardProject) => void;
  onToggleMainBranchWarning: (projectPath: string, hidden: boolean) => void;
  onOpenMoveModal: (project: DashboardProject) => void;
  onOpenMoveWorkspaceModal: (project: DashboardProject) => void;
  onExportAsTemplate: (projectPath: string) => void;
  onUploadThumbnail: (project: DashboardProject) => void;
  onRemoveProject: (project: DashboardProject) => void;

  onOpenFolder: (folderId: string) => void;
  onRenameFolder: (folder: FolderInfo) => void;
  onDeleteFolder: (folder: FolderInfo) => void;

  /** Set of currently pinned project paths (for menu state). */
  pinnedSet?: ReadonlySet<string>;
  /** Toggle pin state for a project. */
  onTogglePin?: (projectPath: string, pinned: boolean) => void | Promise<void>;
  /** Start the create-project flow (drives the zero-projects empty-state CTA). */
  onCreateProject?: () => void;
}

/**
 * Renders the dashboard project/folder collection in grid or list mode.
 * @param props - Projects, folders, selection state, and dashboard action callbacks.
 */
export function ProjectGridView({
  viewMode,
  currentFolderId,
  searchQuery,
  totalCount,
  filteredFolders,
  filteredProjects,
  selectedProjectPaths,
  allVisibleSelected,
  someVisibleSelected,
  onSelectAllVisible,
  onToggleProjectSelection,
  onSelectProject,
  onOpenProjectSettings,
  onDeleteProject,
  onRenameProject,
  onToggleMainBranchWarning,
  onOpenMoveModal,
  onOpenMoveWorkspaceModal,
  onExportAsTemplate,
  onUploadThumbnail,
  onRemoveProject,
  onOpenFolder,
  onRenameFolder,
  onDeleteFolder,
  pinnedSet,
  onTogglePin,
  onCreateProject,
}: ProjectGridViewProps) {
  const checking = useProjectToolsChecking();
  if (totalCount === 0) {
    return (
      <div className="project-list-empty">
        {searchQuery ? (
          <EmptyState
            title={`Nothing matches “${searchQuery}”`}
            description="Try another word, or clear the search."
          />
        ) : currentFolderId ? (
          <EmptyState
            title="Nothing in this folder yet"
            description="Move a project here, or start a new one."
          />
        ) : (
          <EmptyState
            title="No projects yet"
            description="When work becomes a site or an app, it lives here. No repo or code needed: start from a template and an agent builds it."
            action={
              onCreateProject ? (
                <Button
                  variant="primary"
                  onClick={onCreateProject}
                  leftIcon={checking === 'create' ? <Spinner size="sm" /> : <PlusIcon size={16} />}
                  aria-busy={checking === 'create' || undefined}
                >
                  Create your first project
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
    );
  }

  if (viewMode === 'list') {
    return (
      <div className="project-list-view-stack">
        {!currentFolderId && filteredFolders.length > 0 && (
          <div className="project-grid project-grid--folder-strip">
            {filteredFolders.map((folder) => (
              <FolderCard
                key={folder.id}
                folder={folder}
                onOpen={() => onOpenFolder(folder.id)}
                onRename={() => onRenameFolder(folder)}
                onDelete={() => onDeleteFolder(folder)}
              />
            ))}
          </div>
        )}

        {filteredProjects.length > 0 && (
          <ProjectTableView
            projects={filteredProjects}
            selectedProjectPaths={selectedProjectPaths}
            allVisibleSelected={allVisibleSelected}
            someVisibleSelected={someVisibleSelected}
            onSelectAllVisible={onSelectAllVisible}
            onToggleProjectSelection={onToggleProjectSelection}
            onSelectProject={onSelectProject}
            onOpenProjectSettings={onOpenProjectSettings}
            onDeleteProject={onDeleteProject}
            onRenameProject={onRenameProject}
            onToggleMainBranchWarning={onToggleMainBranchWarning}
            onOpenMoveModal={onOpenMoveModal}
            onOpenMoveWorkspaceModal={onOpenMoveWorkspaceModal}
            onExportAsTemplate={onExportAsTemplate}
            onUploadThumbnail={onUploadThumbnail}
            onRemoveProject={onRemoveProject}
            pinnedSet={pinnedSet}
            onTogglePin={onTogglePin}
          />
        )}
      </div>
    );
  }

  return (
    <div className="project-grid">
      {/* Render folders first (only at root level) */}
      {!currentFolderId &&
        filteredFolders.map((folder) => (
          <FolderCard
            key={folder.id}
            folder={folder}
            onOpen={() => onOpenFolder(folder.id)}
            onRename={() => onRenameFolder(folder)}
            onDelete={() => onDeleteFolder(folder)}
          />
        ))}
      {/* Render projects */}
      {filteredProjects.map((project) => (
        <ProjectCard
          key={project.path}
          project={project}
          thumbnailData={project.thumbnailData}
          onSelect={() => onSelectProject(project)}
          onOpenSettings={() => onOpenProjectSettings(project)}
          onDelete={() => onDeleteProject(project)}
          onToggleMainBranchWarning={(hidden) => onToggleMainBranchWarning(project.path, hidden)}
          onRename={project.is_external ? undefined : () => onRenameProject(project)}
          onMoveToFolder={() => onOpenMoveModal(project)}
          onMoveToWorkspace={() => onOpenMoveWorkspaceModal(project)}
          onExportAsTemplate={() => onExportAsTemplate(project.path)}
          onUploadThumbnail={() => onUploadThumbnail(project)}
          isExternal={project.is_external}
          onRemove={() => onRemoveProject(project)}
          isPinned={pinnedSet?.has(project.path) ?? false}
          onTogglePin={onTogglePin ? (pinned) => onTogglePin(project.path, pinned) : undefined}
        />
      ))}
    </div>
  );
}
