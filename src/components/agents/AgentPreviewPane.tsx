/**
 * Preview beside the chat (`lib/agentPreview.ts`): a card's project, running,
 * in a pane next to the conversation, and "Test it", which has the agent click
 * through it there while you watch.
 *
 * - Preview on a result or copy card opens this pane; the chat stays put.
 *   "Open in workspace" is the way to the full workspace.
 * - The frame is the workspace preview's own plumbing (`usePreviewConnection`:
 *   the proxy, the injected inspector, health checks; `useAgentBridge` in pane
 *   mode), with a smaller toolbar: Back, the address, Reload, and a width.
 * - The dev server starts through the window's own dev-server owner, so the
 *   install and "run this project's commands?" gates are the same ones.
 * - The address takes paths on this site only (`parsePreviewAddress` refuses
 *   other hosts). What the page itself loads is up to the page, as in the
 *   workspace preview.
 *
 * @module components/agents/AgentPreviewPane
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  CloseIcon,
  DesktopIcon,
  ErrorIcon,
  ExternalLinkIcon,
  FullBreakpointIcon,
  GlobeIcon,
  LaptopIcon,
  MobileIcon,
  PlayIcon,
  ResetIcon,
  SuccessIcon,
  TabletIcon,
  WarningIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { Spinner } from '../primitives/Spinner';
import { AgentActivityOverlay } from '../preview/AgentActivityOverlay';
import { DevServerConsentPrompt } from '../preview/DevServerConsentPrompt';
import { AttachmentLightbox } from './AgentAttachments';
import { usePreviewConnection } from '../../hooks/usePreviewConnection';
import { useAgentBridge } from '../../hooks/useAgentBridge';
import { useCommands } from '../../commands/useCommands';
import { useOptionalToast } from '../../contexts/ToastContext';
import { usePendingDevServerConsent } from '../../lib/devServerConsent';
import { parsePreviewAddress } from '../../lib/previewUrl';
import { preferredPortForProject } from '../../lib/ports';
import { findAndReservePort } from '../../lib/window';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { attachmentUrl, folderName, type Agent, type Attachment } from '../../lib/agents';
import {
  onPreviewTest,
  paneState,
  portOf,
  previewTarget,
  previewTestState,
  pushLocation,
  runLine,
  startPreviewTest,
  stopPreviewTest,
  type AgentPreviewServer,
  type PreviewRun,
  type PreviewTarget,
  type TestStep,
} from '../../lib/agentPreview';
import type { ViewportPreset } from '../../lib/agentBridge';

import type { PreviewRequest } from './AgentPreviewContext';
export {
  AgentPreviewProvider,
  useAgentPreview,
  useAgentPreviewRequest,
} from './AgentPreviewContext';

// ----------------------------------------------------------------- widths

type Width = 'full' | 'laptop' | 'tablet' | 'mobile';

const WIDTH_PX: Record<Width, number | null> = {
  full: null,
  laptop: 1024,
  tablet: 768,
  mobile: 390,
};

const WIDTH_OPTIONS = [
  { value: 'full' as const, label: <FullBreakpointIcon size={14} />, ariaLabel: 'Full width' },
  { value: 'laptop' as const, label: <LaptopIcon size={14} />, ariaLabel: 'Laptop width' },
  { value: 'tablet' as const, label: <TabletIcon size={14} />, ariaLabel: 'Tablet width' },
  { value: 'mobile' as const, label: <MobileIcon size={14} />, ariaLabel: 'Phone width' },
];

function widthFor(value: number | ViewportPreset): { width: Width; custom: number | null } {
  if (typeof value === 'number') return { width: 'full', custom: value };
  if (value === 'desktop') return { width: 'full', custom: 1440 };
  return { width: value === 'full' ? 'full' : value, custom: null };
}

// ----------------------------------------------------------------- the pane

interface AgentPreviewPaneProps {
  agent: Agent;
  request: PreviewRequest;
  server?: AgentPreviewServer;
  onClose: () => void;
  onOpenInWorkspace?: (path: string) => void;
}

/** The pane: what the card previews, started if need be, then the frame. */
export function AgentPreviewPane({
  agent,
  request,
  server,
  onClose,
  onOpenInWorkspace,
}: AgentPreviewPaneProps) {
  const { showToast } = useOptionalToast();
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [startSettled, setStartSettled] = useState(false);
  // Read when the open runs, without re-running it on every server change.
  const serverRef = useRef(server);
  useEffect(() => {
    serverRef.current = server;
  });

  // Resolve what the card previews, then make sure something serves it.
  useEffect(() => {
    // The pane is keyed by its card, so a fresh one starts from nothing; a
    // second press of Preview only checks again.
    let live = true;
    void (async () => {
      try {
        const t = await previewTarget(request.agentId, request.messageId);
        if (!live) return;
        setTarget(t);
        const owner = serverRef.current;
        const snap = owner?.status(t.path);
        if (snap && (snap.status === 'ready' || snap.status === 'starting')) {
          setPort(portOf(snap.address) ?? t.port ?? null);
          setStartSettled(true);
          return;
        }
        if (t.running && t.port) {
          setPort(t.port);
          setStartSettled(true);
          return;
        }
        if (!owner) {
          setError('Previews start from the main window.');
          return;
        }
        const preferred = t.port ?? preferredPortForProject(t.path);
        const reserved = await findAndReservePort(t.path, preferred).catch(() => preferred);
        if (!live) return;
        setPort(reserved);
        await owner.start(t.path, folderName(t.project), reserved);
        if (live) setStartSettled(true);
      } catch (e) {
        if (live) setError(formatCommandError(asCommandError(e)));
      }
    })();
    return () => {
      live = false;
    };
  }, [request.agentId, request.messageId, request.n]);

  const consent = usePendingDevServerConsent(target?.path ?? null);
  const state = paneState({
    error,
    target,
    consentPending: Boolean(consent),
    needsInstall: target && server ? server.needsInstall(target.path) : null,
    projectType: target && server ? server.projectType(target.path) : null,
    server: target && server ? server.status(target.path) : null,
    port,
    startSettled,
  });

  const name = target ? folderName(target.project) : null;
  const where = target ? (target.copy ? `A copy of ${name}` : name) : null;
  const openInWorkspace =
    target && onOpenInWorkspace ? () => onOpenInWorkspace(target.path) : undefined;

  // The test, as the backend has it: started here or picked up mid-run.
  const run = useAgentRun(agent.id, target);
  const close = useCallback(() => {
    if (run?.state === 'running') void stopPreviewTest(agent.id).catch(() => undefined);
    onClose();
  }, [run?.state, agent.id, onClose]);

  const working = agent.status.state !== 'idle';
  const testing = run?.state === 'running';
  const startTest = useCallback(async () => {
    try {
      await startPreviewTest(request.agentId, request.messageId);
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    }
  }, [request.agentId, request.messageId, showToast]);
  const stopTest = useCallback(() => {
    void stopPreviewTest(agent.id).catch((e: unknown) =>
      showToast(formatCommandError(asCommandError(e)), 'error')
    );
  }, [agent.id, showToast]);

  // "Test it" pressed on the card: once, when the site is up.
  const autoStarted = useRef<number | null>(null);
  const ready = state.kind === 'ready';
  useEffect(() => {
    if (!request.test || !ready || autoStarted.current === request.n) return;
    autoStarted.current = request.n;
    // The pane's bridge listener attaches as the frame mounts; give it a beat.
    const timer = setTimeout(() => void startTest(), 400);
    return () => clearTimeout(timer);
  }, [request.test, request.n, ready, startTest]);

  useCommands(
    () => [
      {
        id: 'agents.preview.close',
        title: 'Close the preview',
        icon: <CloseIcon size={14} />,
        category: 'action' as const,
        keywords: ['preview', 'site', 'pane'],
        run: close,
      },
      ...(ready && !testing && !working
        ? [
            {
              id: 'agents.preview.test',
              title: 'Test it in the preview',
              icon: <PlayIcon size={14} />,
              category: 'action' as const,
              keywords: ['test', 'click through', 'try', 'preview', 'site'],
              run: () => void startTest(),
            },
          ]
        : []),
      ...(openInWorkspace
        ? [
            {
              id: 'agents.preview.openInWorkspace',
              title: 'Open the preview in the workspace',
              icon: <ExternalLinkIcon size={14} />,
              category: 'navigation' as const,
              keywords: ['workspace', 'project', 'preview'],
              run: openInWorkspace,
            },
          ]
        : []),
    ],
    [close, ready, testing, working, startTest, openInWorkspace]
  );

  const testButton = testing ? (
    <Button variant="secondary" size="compact" onClick={stopTest}>
      Stop test
    </Button>
  ) : (
    <Button
      variant="strong"
      size="compact"
      leftIcon={<PlayIcon size={12} />}
      disabled={!ready || working}
      title={working ? `${agent.name} is busy; try when it's done` : undefined}
      onClick={() => void startTest()}
    >
      {run?.state === 'reported' ? 'Test again' : 'Test it'}
    </Button>
  );

  return (
    <aside className="agent-preview" aria-label="Preview" data-state={state.kind}>
      <header className="agent-preview__header">
        <GlobeIcon size={14} />
        <div className="agent-preview__heading">
          <span className="agent-preview__title">{target?.title ?? name ?? 'Preview'}</span>
          {where && <span className="agent-preview__where">{where}</span>}
        </div>
        <div className="agent-preview__header-actions">
          {testButton}
          {openInWorkspace && (
            <Button variant="ghost" size="compact" onClick={openInWorkspace}>
              Open in workspace
            </Button>
          )}
          <IconButton
            variant="ghost"
            size="compact"
            icon={<CloseIcon size={14} />}
            onClick={close}
            aria-label="Close the preview"
            title="Close the preview"
          />
        </div>
      </header>
      <div className="agent-preview__body">
        <div className="agent-preview__stage">
          {state.kind === 'ready' && target ? (
            <PaneFrame target={target} port={state.port} server={server} />
          ) : (
            <PaneStatus
              state={state}
              where={name}
              consent={target && consent ? { path: target.path, pending: consent } : null}
              onOpenInWorkspace={openInWorkspace}
            />
          )}
        </div>
        {run && <RunSteps agent={agent} run={run} />}
      </div>
    </aside>
  );
}

/** The run for this agent, kept live from the backend's events. */
function useAgentRun(agentId: string, target: PreviewTarget | null): PreviewRun | null {
  const [run, setRun] = useState<PreviewRun | null>(null);
  useEffect(() => {
    let live = true;
    let off: (() => void) | null = null;
    void previewTestState(agentId)
      .then((r) => live && r && setRun(r))
      .catch(() => undefined);
    void onPreviewTest((r) => {
      if (r.agentId === agentId) setRun(r);
    }).then((fn) => {
      if (live) off = fn;
      else fn();
    });
    return () => {
      live = false;
      off?.();
    };
  }, [agentId]);
  // Only a run in the folder this pane shows belongs here.
  if (!run || !target || run.path !== target.path) return null;
  return run;
}

// ----------------------------------------------------------------- states

function PaneStatus({
  state,
  where,
  consent,
  onOpenInWorkspace,
}: {
  state: ReturnType<typeof paneState>;
  where: string | null;
  consent: {
    path: string;
    pending: NonNullable<ReturnType<typeof usePendingDevServerConsent>>;
  } | null;
  onOpenInWorkspace?: () => void;
}) {
  if (state.kind === 'consent' && consent) {
    return (
      <div className="agent-preview__status agent-preview__status--consent">
        <DevServerConsentPrompt projectPath={consent.path} pending={consent.pending} />
      </div>
    );
  }
  const open = onOpenInWorkspace && (
    <Button variant="secondary" size="compact" onClick={onOpenInWorkspace}>
      Open in workspace
    </Button>
  );
  const body = (() => {
    switch (state.kind) {
      case 'failed':
        return { icon: <WarningIcon size={16} />, line: state.message, action: null };
      case 'install':
        return {
          icon: <WarningIcon size={16} />,
          line: `${where ?? 'This project'} needs its dependencies installed first. The workspace installs them.`,
          action: open,
        };
      case 'no-preview':
        return {
          icon: <GlobeIcon size={16} />,
          line: `${where ?? 'This project'} has no web preview to show here.`,
          action: open,
        };
      case 'stopped':
        return {
          icon: <WarningIcon size={16} />,
          line: 'The site stopped running. The workspace shows why and can start it again.',
          action: open,
        };
      default:
        return {
          icon: <Spinner size="sm" />,
          line: where ? `Starting ${where}…` : 'Getting the preview ready…',
          action: null,
        };
    }
  })();
  return (
    <div className="agent-preview__status" role="status">
      <span className="agent-preview__status-icon">{body.icon}</span>
      <p className="agent-preview__status-line">{body.line}</p>
      {body.action}
    </div>
  );
}

// ----------------------------------------------------------------- the frame

function PaneFrame({
  target,
  port,
  server,
}: {
  target: PreviewTarget;
  port: number;
  server?: AgentPreviewServer;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState<Width>('full');
  const [custom, setCustom] = useState<number | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  // The site's first page has loaded in the frame (for the UI harness to wait on).
  const [loaded, setLoaded] = useState(false);
  const [stageWidth, setStageWidth] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const conn = usePreviewConnection({
    port,
    projectPath: target.path,
    isDevServerRestarting: false,
    isStaticProject: server?.projectType(target.path) === 'statichtml',
    enabled: true,
    serverAlreadyRunning: target.running,
  });

  const location = conn.currentLocation;
  useEffect(() => {
    setHistory((h) => pushLocation(h, location));
  }, [location]);

  // The workspace preview's reload: an about:blank round trip on the page
  // the frame is actually on (client-side navigation never updates `src`).
  const reload = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame || !conn.serverReady) return;
    conn.setIframePath(conn.currentLocation);
    const url = `${conn.baseUrl}${conn.currentLocation === '/' ? '' : conn.currentLocation}`;
    frame.src = 'about:blank';
    setTimeout(() => {
      if (iframeRef.current) iframeRef.current.src = url;
    }, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- conn's identity changes every render
  }, [conn.serverReady, conn.baseUrl, conn.currentLocation, conn.setIframePath]);
  const lastReload = useRef(0);
  useEffect(() => {
    if (conn.reloadToken === lastReload.current) return;
    lastReload.current = conn.reloadToken;
    if (conn.reloadToken !== 0) reload();
  }, [conn.reloadToken, reload]);

  const back = () => {
    if (history.length < 2) return;
    const previous = history[history.length - 2];
    setHistory((h) => h.slice(0, -2));
    conn.handlePageSelect(previous);
  };

  const framePx = custom ?? WIDTH_PX[width];
  const scale = framePx && stageWidth && framePx > stageWidth ? stageWidth / framePx : 1;

  useAgentBridge({
    mode: 'pane',
    projectPath: target.path,
    currentUrl: conn.serverReady ? conn.currentUrl : null,
    serverReady: conn.serverReady,
    currentPath: conn.currentPage,
    pages: conn.filteredPages.map((p) => p.route),
    navigate: conn.handlePageSelect,
    reload,
    setViewport: (value) => {
      const next = widthFor(value);
      setWidth(next.width);
      setCustom(next.custom);
    },
    getViewportWidth: () => framePx,
    canvasMode: false,
    getOverlayFrameSize: () => null,
  });

  // How wide the stage is, so a device wider than the pane shrinks to fit.
  const setStage = useCallback((el: HTMLDivElement | null) => {
    stageRef.current = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const submitAddress = () => {
    if (address === null) return;
    const next = parsePreviewAddress(address, conn.currentPage);
    setAddress(null);
    if (next) conn.handlePageSelect(next);
  };

  return (
    <div className="agent-preview__frame-wrap">
      <div className="agent-preview__toolbar">
        <IconButton
          variant="ghost"
          size="compact"
          icon={<ArrowLeftIcon size={14} />}
          onClick={back}
          disabled={history.length < 2}
          aria-label="Back"
          title="Back"
        />
        <input
          className="agent-preview__address"
          aria-label="Address"
          value={address ?? location}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setAddress(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAddress();
            if (e.key === 'Escape') setAddress(null);
          }}
          spellCheck={false}
        />
        <IconButton
          variant="ghost"
          size="compact"
          icon={<ResetIcon size={14} />}
          onClick={conn.handleRefresh}
          aria-label="Reload"
          title="Reload"
        />
        <SegmentedControl
          aria-label="Width"
          value={custom ? 'full' : width}
          options={WIDTH_OPTIONS}
          onValueChange={(v) => {
            setWidth(v);
            setCustom(null);
          }}
        />
      </div>
      <div className="agent-preview__viewport" ref={setStage}>
        {!conn.serverReady && (
          <div className="agent-preview__status" role="status">
            <Spinner size="sm" />
            <p className="agent-preview__status-line">
              {conn.hasError ? 'The site isn’t answering.' : 'Loading the site…'}
            </p>
            {conn.hasError && (
              <Button variant="secondary" size="compact" onClick={conn.handleRetry}>
                Try again
              </Button>
            )}
          </div>
        )}
        <div
          className="agent-preview__device"
          data-width={framePx ? 'fixed' : 'full'}
          style={
            framePx
              ? {
                  width: `${framePx}px`,
                  height: `${100 / scale}%`,
                  transform: scale < 1 ? `scale(${scale})` : undefined,
                }
              : undefined
          }
        >
          <iframe
            key={target.path}
            ref={iframeRef}
            className="agent-preview__iframe"
            src={conn.serverReady ? conn.currentUrl : 'about:blank'}
            title={`Preview of ${folderName(target.project)}`}
            data-tooltip-disabled
            onLoad={(e) => {
              if (e.currentTarget.getAttribute('src') !== 'about:blank') setLoaded(true);
              conn.handleIframeLoad();
            }}
            data-loaded={loaded || undefined}
            hidden={!conn.serverReady}
          />
          <AgentActivityOverlay />
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- the steps

function StepIcon({ step }: { step: TestStep }) {
  if (!step.ok) return <ErrorIcon size={12} />;
  if (step.kind === 'shot') return <DesktopIcon size={12} />;
  return <SuccessIcon size={12} />;
}

/** What the agent did in the pane, live, with its screenshots. */
export function RunSteps({ agent, run }: { agent: Agent; run: PreviewRun }) {
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const count = run.steps.length;
  useEffect(() => {
    const list = listRef.current;
    if (list && typeof list.scrollTo === 'function') {
      list.scrollTo({ top: list.scrollHeight });
    }
  }, [count]);
  return (
    <section className="agent-preview__steps" aria-label="What it's doing" data-run={run.state}>
      <h3 className="agent-preview__steps-title">
        {run.state === 'running' && <Spinner size="sm" />}
        {runLine(run)}
      </h3>
      <ol className="agent-preview__step-list" ref={listRef} aria-live="polite">
        {run.steps.map((step, i) => (
          <li
            key={`${step.ts}:${i}`}
            className="agent-preview__step"
            data-ok={step.ok || undefined}
            data-kind={step.kind}
          >
            <div className="agent-preview__step-head">
              <span className="agent-preview__step-icon">
                <StepIcon step={step} />
              </span>
              <span className="agent-preview__step-label">{step.label}</span>
            </div>
            {step.shot && (
              <button
                type="button"
                className="agent-preview__step-shot"
                onClick={() => setViewing(step.shot!)}
                aria-label={`View screenshot: ${step.label}`}
              >
                <img src={attachmentUrl(agent.home, step.shot)} alt="" loading="lazy" />
              </button>
            )}
          </li>
        ))}
      </ol>
      <AttachmentLightbox agent={agent} viewing={viewing} onClose={() => setViewing(null)} />
    </section>
  );
}
