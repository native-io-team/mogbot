/**
 * CreateProject component that provides a wizard for creating new projects.
 *
 * This is a multi-step wizard that:
 * 1. Lets user select a project template (built-in or from zip file)
 * 2. Lets user enter a project name
 * 3. Shows progress while cloning, initializing, and installing dependencies
 *
 * Uses Tauri PTY for running git clone and npm install with progress events.
 *
 * @module components/CreateProject
 */

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../../lib/logger';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  CheckIcon,
  CloseIcon,
  ErrorIcon,
  FileIcon,
  PendingCircleIcon,
  UploadIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { ModalFrame } from '../primitives/ModalFrame';
import { Spinner } from '../primitives/Spinner';
import { TextButton } from '../primitives/TextButton';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import {
  useProjectCreation,
  TEMPLATES,
  TEMPLATE_GROUPS,
  STEPS,
  STATUS_MESSAGES,
} from '../../hooks/useProjectCreation';
import { useAsyncState } from '../../hooks/useAsyncState';
import { TemplateGallery, type CommunityTemplate } from './TemplateGallery';
import { BRAND_LINKS } from '../../lib/brand';

/** The community gallery needs a template API of our own (`links.templateApi`). */
const TEMPLATE_GALLERY_ENABLED = BRAND_LINKS.templateApi !== null;
import { TemplateCard } from './TemplateCard';
import { SiteUrlPanel, normaliseUrl } from '../migration/SiteUrlPanel';
import { availableOutcomes, outcomeFor, templateForOutcome } from '../../lib/projectOutcomes';

const OUTCOMES = availableOutcomes(TEMPLATES);

/** Props for the CreateProject component */
interface CreateProjectProps {
  /** Callback when project creation completes successfully */
  onComplete: (projectPath: string) => void;
  /** Callback when user cancels the wizard */
  onCancel: () => void;
}

export function CreateProject({ onComplete, onCancel }: CreateProjectProps) {
  const {
    formStep,
    selectedTemplate,
    projectName,
    setProjectName,
    isCreating,
    currentStep,
    error,
    createdProjectPath,
    isDragging,
    fileInputRef,
    dropZoneRef,
    hasZipTemplate,
    displayZipName,
    handleCreate,
    handleCreateFromZip,
    handleTemplateSelect,
    handleContinue: rawHandleContinue,
    handleBack,
    retryInstall,
    getStepStatus,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelect,
    handleRemoveZip,
    setZipPath,
    setZipFileName,
    setError,
    saveDefaultTemplate,
    defaultTemplateId,
    setMigrationUrl,
  } = useProjectCreation({ onComplete, onCancel });

  const [setAsDefaultChecked, setSetAsDefaultChecked] = useState(false);
  // Frameworks are a second question, asked only of people who open it. It
  // starts open when the saved default belongs to no outcome (Eve agent).
  const [showFrameworks, setShowFrameworks] = useState(
    () => selectedTemplate !== null && outcomeFor(selectedTemplate.id) === null
  );
  const selectedOutcome = hasZipTemplate ? null : outcomeFor(selectedTemplate?.id);

  // Tab state: "scratch" = start from scratch, "template" = community templates
  const [activeTab, setActiveTab] = useState<'scratch' | 'template' | 'url'>('scratch');
  // The address being rebuilt, as typed. Normalised only when it is used,
  // so the field never rewrites what someone is halfway through typing.
  const [siteUrl, setSiteUrl] = useState('');
  const normalisedSiteUrl = normaliseUrl(siteUrl);
  const siteUrlInvalid = siteUrl.trim().length > 0 && normalisedSiteUrl === null;

  // Community templates from API
  const [communitySearch, setCommunitySearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Debounce search input — hit the API server-side
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(communitySearch), 300);
    return () => clearTimeout(timer);
  }, [communitySearch]);

  // Fetch templates from API (server-side search). The search term is an
  // argument, not a closure, so `execute` stays stable across keystrokes.
  const {
    data: fetchedTemplates,
    isLoading: isFetchingTemplates,
    error: fetchTemplatesError,
    execute: fetchTemplates,
  } = useAsyncState<CommunityTemplate[], [string]>(
    async (search: string) => {
      const params: Record<string, string | number> = {};
      if (search) params.search = search;
      const raw = await invoke<string>('fetch_community_templates', params);
      return (JSON.parse(raw) as { templates: CommunityTemplate[] }).templates;
    },
    {
      onError: (err) => {
        // The backend classifies these Expected (offline / API unreachable), so
        // warn rather than error — but the user must still be told the fetch
        // failed instead of being shown "No templates found" (issue #754).
        logger.warn('[CreateProject] Failed to fetch community templates', { error: err.message });
      },
    }
  );

  /**
   * Set when the fetch itself failed (offline, API down, parse error) so the
   * gallery can say so and offer a retry, instead of the identical-looking
   * "No templates found" the search-miss case shows (issue #754).
   */
  const communityError = fetchTemplatesError?.message ?? null;
  // A failed fetch shows the error, never a stale list from an earlier search.
  const communityTemplates = communityError ? [] : (fetchedTemplates ?? []);
  // `data === null` means the first fetch hasn't landed yet — still loading, so
  // the first paint is skeletons rather than a momentary "No templates found".
  const communityLoading =
    isFetchingTemplates || (fetchedTemplates === null && fetchTemplatesError === null);

  // Fetch on mount and when search changes
  useEffect(() => {
    if (!TEMPLATE_GALLERY_ENABLED) return;
    void fetchTemplates(debouncedSearch);
  }, [fetchTemplates, debouncedSearch]);

  // Re-fetch every 50 minutes to keep signed zip_urls fresh (they expire after 1 hour)
  useEffect(() => {
    if (!TEMPLATE_GALLERY_ENABLED) return;
    const interval = setInterval(() => void fetchTemplates(debouncedSearch), 50 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchTemplates, debouncedSearch]);

  const handleCommunitySelect = (template: CommunityTemplate) => {
    setSelectedCommunityId(template.id === selectedCommunityId ? null : template.id);
  };

  const selectedCommunityTemplate =
    communityTemplates.find((t) => t.id === selectedCommunityId) ?? null;

  /**
   * A project name from the site's host.
   *
   * The host, never the path: naming it after the page someone happened to
   * paste would give `/pricing` and `/about` different project names for the
   * same site.
   */
  const nameFromUrl = (url: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-');
    } catch {
      return 'migrated-site';
    }
  };

  const handleContinue = async () => {
    if (activeTab === 'url') {
      if (!normalisedSiteUrl || !selectedTemplate) return;
      // Carried into creation so the hand-off happens in the same breath as
      // the workspace opening; the name is only a suggestion and the next
      // step still lets it be changed.
      setMigrationUrl(normalisedSiteUrl);
      setProjectName(nameFromUrl(normalisedSiteUrl));
      rawHandleContinue();
      return;
    }

    if (activeTab === 'scratch') {
      if (setAsDefaultChecked && selectedTemplate) {
        saveDefaultTemplate(selectedTemplate.id);
      }
      rawHandleContinue();
      return;
    }

    // Template tab — community template selected
    if (selectedCommunityTemplate?.zip_url) {
      setDownloading(true);
      try {
        const tempPath = await invoke<string>('download_template_zip', {
          url: selectedCommunityTemplate.zip_url,
        });
        setZipPath(tempPath);
        setZipFileName(selectedCommunityTemplate.name + '.zip');
        rawHandleContinue();
      } catch (err) {
        // Surface the failure (don't block the modal) — a silent catch left the
        // button snapping back to "Continue" with no explanation.
        const detail = formatCommandError(asCommandError(err));
        logger.error('Failed to download community template', {
          template: selectedCommunityTemplate.name,
          error: detail,
        });
        setError(
          `Couldn't download "${selectedCommunityTemplate.name}": ${detail}. ` +
            'Check your connection and try again.'
        );
      } finally {
        setDownloading(false);
      }
      return;
    }

    // Template tab — zip upload selected
    if (hasZipTemplate) {
      rawHandleContinue();
    }
  };

  const renderContent = () => {
    // Creating state - show progress
    if (isCreating) {
      return (
        <div className="create-modal-content creating">
          <h2>Creating "{projectName}"</h2>

          <Spinner size="lg" className="create-spinner" />

          <p className="create-status">{STATUS_MESSAGES[currentStep]}</p>

          <div className="create-checklist">
            {STEPS.slice(0, -1).map((step) => {
              const status = getStepStatus(step.id);
              return (
                <div key={step.id} className={`checklist-item ${status}`}>
                  {status === 'done' ? (
                    <CheckIcon size={18} />
                  ) : status === 'active' ? (
                    <Spinner />
                  ) : (
                    <PendingCircleIcon size={18} />
                  )}
                  <span>{step.label}</span>
                </div>
              );
            })}
          </div>

          {error && (
            <div className="create-error">
              <p style={{ whiteSpace: 'pre-line', maxHeight: '200px', overflowY: 'auto' }}>
                {error}
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                {currentStep === 'install' && createdProjectPath && (
                  <Button variant="primary" onClick={() => void retryInstall()}>
                    Retry
                  </Button>
                )}
                <Button variant="secondary" onClick={onCancel}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Template selection step
    if (formStep === 'select-template') {
      return (
        <div className="create-modal-content">
          <Tabs value={activeTab} onValueChange={(next) => setActiveTab(next as typeof activeTab)}>
            <TabsList className="create-tabs" variant="stretch" aria-label="Project source">
              <TabsTab value="scratch" className="create-tab">
                Start fresh
              </TabsTab>
              <TabsTab value="template" className="create-tab">
                From a template
              </TabsTab>
              <TabsTab value="url" className="create-tab">
                From a URL
              </TabsTab>
            </TabsList>

            <TabsPanel value="scratch" className="create-tab-panel">
              {activeTab === 'scratch' && (
                <>
                  <div className="stack-grid stack-grid--outcomes">
                    {OUTCOMES.map((outcome) => {
                      const picked = selectedOutcome?.id === outcome.id;
                      const framework = templateForOutcome(
                        outcome,
                        TEMPLATES,
                        selectedTemplate?.id ?? null,
                        defaultTemplateId
                      );
                      // Which framework it will use, only where there's a choice.
                      const meta =
                        outcome.templateIds.length > 1 && framework ? framework.name : undefined;
                      return (
                        <TemplateCard
                          key={outcome.id}
                          name={outcome.name}
                          description={outcome.description}
                          meta={meta}
                          selected={picked}
                          onSelect={() => {
                            if (framework) handleTemplateSelect(framework);
                            setSetAsDefaultChecked(false);
                          }}
                        />
                      );
                    })}
                  </div>

                  <TextButton
                    className="create-more-options"
                    aria-expanded={showFrameworks}
                    onClick={() => setShowFrameworks((v) => !v)}
                  >
                    {showFrameworks ? 'Fewer options' : 'More options'}
                  </TextButton>

                  {showFrameworks &&
                    TEMPLATE_GROUPS.map((group) => {
                      const groupTemplates = TEMPLATES.filter((t) => t.category === group.id);
                      if (groupTemplates.length === 0) return null;
                      return (
                        <div key={group.id} className="stack-group">
                          <h3 className="stack-group-title">{group.label}</h3>
                          <div className="stack-grid">
                            {groupTemplates.map((template) => (
                              <TemplateCard
                                key={template.id}
                                name={template.name}
                                description={template.description}
                                selected={selectedTemplate?.id === template.id && !hasZipTemplate}
                                onSelect={() => {
                                  handleTemplateSelect(template);
                                  setSetAsDefaultChecked(false);
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}

                  {selectedTemplate &&
                    selectedTemplate.id !== defaultTemplateId &&
                    !hasZipTemplate && (
                      <button
                        type="button"
                        className={`template-default-toggle ${setAsDefaultChecked ? 'active' : ''}`}
                        onClick={() => setSetAsDefaultChecked(!setAsDefaultChecked)}
                      >
                        {setAsDefaultChecked ? 'Will be your default' : 'Set as default?'}
                      </button>
                    )}
                </>
              )}
            </TabsPanel>

            <TabsPanel value="template" className="create-tab-panel">
              {activeTab === 'template' && (
                <>
                  {TEMPLATE_GALLERY_ENABLED && (
                    <>
                      <TemplateGallery
                        templates={communityTemplates}
                        loading={communityLoading}
                        onSelect={handleCommunitySelect}
                        selectedId={selectedCommunityId}
                        searchQuery={communitySearch}
                        onSearchChange={setCommunitySearch}
                        loadError={communityError}
                        onRetry={() => void fetchTemplates(debouncedSearch)}
                      />

                      <div className="template-divider">
                        <span>or upload a template</span>
                      </div>
                    </>
                  )}

                  {!hasZipTemplate ? (
                    <div
                      ref={dropZoneRef}
                      className={`template-dropzone ${isDragging ? 'dragging' : ''}`}
                      onDragEnter={handleDragEnter}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".zip"
                        onChange={handleFileSelect}
                        style={{ display: 'none' }}
                      />
                      <UploadIcon size={24} />
                      <p>Drop a template .zip file here</p>
                      <span>or click to browse</span>
                    </div>
                  ) : (
                    <div className="template-zip-selected">
                      <div className="template-zip-info">
                        <FileIcon size={20} />
                        <span>{displayZipName}</span>
                      </div>
                      <button
                        type="button"
                        className="template-zip-remove"
                        onClick={handleRemoveZip}
                      >
                        <CloseIcon size={16} />
                      </button>
                    </div>
                  )}
                </>
              )}
            </TabsPanel>

            <TabsPanel value="url" className="create-tab-panel">
              {activeTab === 'url' && (
                <SiteUrlPanel
                  url={siteUrl}
                  onUrlChange={setSiteUrl}
                  templates={TEMPLATES.filter((t) => t.category === 'web')}
                  selectedTemplateId={selectedTemplate?.id ?? null}
                  onSelectTemplate={handleTemplateSelect}
                  invalid={siteUrlInvalid}
                />
              )}
            </TabsPanel>
          </Tabs>

          {error && (
            <p className="error">
              <ErrorIcon size={12} className="inline-error-icon" />
              {error}
            </p>
          )}

          <div className="create-actions">
            <Button variant="secondary" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              disabled={
                downloading ||
                (activeTab === 'scratch'
                  ? !selectedTemplate && !hasZipTemplate
                  : activeTab === 'url'
                    ? !normalisedSiteUrl || !selectedTemplate
                    : !selectedCommunityId && !hasZipTemplate)
              }
              onClick={() => void handleContinue()}
            >
              {downloading ? 'Downloading...' : 'Continue'}
            </Button>
          </div>
        </div>
      );
    }

    // Name entry step
    return (
      <div className="create-modal-content">
        <p className="template-context">
          Using{' '}
          <strong>
            {hasZipTemplate ? displayZipName?.replace('.zip', '') : selectedTemplate?.name}
          </strong>
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (hasZipTemplate) {
              void handleCreateFromZip();
            } else {
              void handleCreate();
            }
          }}
        >
          <label>
            Project name
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="my-awesome-site"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>

          {error && (
            <p className="error">
              <ErrorIcon size={12} className="inline-error-icon" />
              {error}
            </p>
          )}

          <div className="create-actions">
            <Button variant="secondary" type="button" onClick={handleBack}>
              Back
            </Button>
            <Button variant="primary" type="submit">
              Create project
            </Button>
          </div>
        </form>
      </div>
    );
  };

  return (
    <ModalFrame
      isOpen
      onClose={onCancel}
      title="New project"
      dismissable={!isCreating}
      showCloseButton={!isCreating}
      className="create-project-modal"
    >
      {renderContent()}
    </ModalFrame>
  );
}
