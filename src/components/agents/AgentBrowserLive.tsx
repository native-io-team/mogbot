/**
 * Watching an agent in its own browser (the agents' Chrome,
 * `agent_browser::live`), without a Chrome window jumping over the app.
 *
 * - **The card** (`BrowserLiveCard`): under the working line while it has a
 *   page open, a small live picture of that page (about two frames a
 *   second), its site and a "Live" mark. Pressing it opens the pane.
 * - **The pane** (`AgentBrowserPane`): the same page, larger, beside the
 *   chat in the preview's place, with its address. View only; "Open in
 *   Chrome" brings the real window forward for anyone who wants to step in.
 * - **The still** (`BrowserStill`): once the turn ends, its reply's "What it
 *   did" keeps the last picture it showed (this session only; pictures of
 *   pages aren't written down).
 *
 * Frames are asked for only while they can be seen (`useLiveBrowser`).
 *
 * @module components/agents/AgentBrowserLive
 */

import { useCallback, useRef, useState } from 'react';
import {
  CloseIcon,
  ExpandDiagonalIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockedIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Spinner } from '../primitives/Spinner';
import { useLiveBrowser } from '../../hooks/useLiveBrowser';
import { useCommands } from '../../commands/useCommands';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import type { Agent, TurnWork } from '../../lib/agents';
import {
  lastFrameOf,
  showAgentBrowser,
  siteOf,
  siteOfStep,
  type LiveBrowserFrame,
} from '../../lib/agentsOwnBrowser';
import { useAgentPreview, useAgentPreviewRequest } from './AgentPreviewContext';

/** The site to name: the page's own address, else the step's words. */
function siteName(frame: LiveBrowserFrame | null, work?: TurnWork): string {
  return siteOf(frame?.url) ?? siteOfStep(work?.current?.label) ?? 'Its browser';
}

/** The picture, or a quiet stand-in until the first one comes. */
function Screen({
  frame,
  waiting,
  className,
}: {
  frame: LiveBrowserFrame | null;
  waiting: boolean;
  className: string;
}) {
  return (
    <span className={className} data-empty={!frame || undefined}>
      {frame ? (
        <img src={frame.src} alt="" draggable={false} />
      ) : (
        <span className="agent-browser__placeholder" aria-hidden>
          {waiting ? <Spinner size="sm" /> : <GlobeIcon size={16} />}
        </span>
      )}
    </span>
  );
}

/** "● Live", or what it is instead. */
function LiveMark({ state }: { state: 'live' | 'beside' | 'ended' }) {
  return (
    <span className="agent-browser__mark" data-state={state}>
      {state === 'live' && <span className="agent-browser__dot" aria-hidden />}
      {state === 'live' ? 'Live' : state === 'beside' ? 'Open beside' : 'Last seen'}
    </span>
  );
}

interface CardProps {
  agent: Agent;
  work: TurnWork;
}

/** Under the working line: the page it's on, live, small. */
export function BrowserLiveCard({ agent, work }: CardProps) {
  const pane = useAgentPreview();
  const request = useAgentPreviewRequest();
  const beside = Boolean(request?.browser && request.agentId === agent.id);
  const ref = useRef<HTMLButtonElement>(null);
  // The pane is showing it larger: this one rests on its last picture.
  const { frame } = useLiveBrowser(agent.id, {
    enabled: !beside,
    turnStartedAt: work.startedAt,
    target: ref,
  });
  const site = siteName(frame, work);
  const open = () => pane?.openBrowser(agent.id, work.startedAt);
  return (
    <button
      ref={ref}
      type="button"
      className="agent-browser-card"
      data-beside={beside || undefined}
      aria-label={`Watch ${agent.name} on ${site}`}
      title={frame?.title || undefined}
      disabled={!pane}
      onClick={open}
    >
      <span className="agent-browser-card__bar">
        <GlobeIcon size={12} />
        <span className="agent-browser-card__site">{site}</span>
        <LiveMark state={beside ? 'beside' : 'live'} />
      </span>
      <Screen frame={frame} waiting className="agent-browser-card__screen" />
      {pane && (
        <span className="agent-browser-card__hint" aria-hidden>
          <ExpandDiagonalIcon size={12} />
          Watch
        </span>
      )}
    </button>
  );
}

/** In a finished turn's "What it did": the last picture it showed, if this session saw it. */
export function BrowserStill({ agent, work }: CardProps) {
  const pane = useAgentPreview();
  const frame = lastFrameOf(agent.id, work.startedAt);
  if (!frame) return null;
  const site = siteName(frame);
  return (
    <button
      type="button"
      className="agent-browser-card agent-browser-card--still"
      aria-label={`The last page ${agent.name} had open: ${site}`}
      title={frame.title || undefined}
      disabled={!pane}
      onClick={() => pane?.openBrowser(agent.id, work.startedAt)}
    >
      <span className="agent-browser-card__bar">
        <GlobeIcon size={12} />
        <span className="agent-browser-card__site">{site}</span>
        <LiveMark state="ended" />
      </span>
      <Screen frame={frame} waiting={false} className="agent-browser-card__screen" />
    </button>
  );
}

interface PaneProps {
  agent: Agent;
  turnStartedAt: number;
  onClose: () => void;
}

/** Beside the chat: the page, larger, with its address. View only. */
export function AgentBrowserPane({ agent, turnStartedAt, onClose }: PaneProps) {
  const { showToast } = useOptionalToast();
  const work = agent.status.work;
  const sameTurn = work?.startedAt === turnStartedAt;
  const live = agent.status.state !== 'idle' && sameTurn && Boolean(work?.ownBrowser);
  const { frame: liveFrame } = useLiveBrowser(agent.id, {
    enabled: live,
    large: true,
    turnStartedAt,
  });
  const frame = liveFrame ?? lastFrameOf(agent.id, turnStartedAt);
  const [opening, setOpening] = useState(false);
  const site = siteName(frame, sameTurn ? work : undefined);
  const secure = frame?.url.startsWith('https://') ?? false;

  const openInChrome = useCallback(async () => {
    setOpening(true);
    try {
      await showAgentBrowser(agent.id, true);
    } catch (e) {
      showToast(formatCommandError(asCommandError(e)), 'error');
    } finally {
      setOpening(false);
    }
  }, [agent.id, showToast]);

  useCommands(
    () => [
      {
        id: 'agents.browser.close',
        title: 'Close the live view',
        icon: <CloseIcon size={14} />,
        category: 'action' as const,
        keywords: ['browser', 'live', 'watch', 'pane'],
        run: onClose,
      },
      ...(live
        ? [
            {
              id: 'agents.browser.openInChrome',
              title: `Open ${agent.name}’s page in Chrome`,
              icon: <ExternalLinkIcon size={14} />,
              category: 'action' as const,
              keywords: ['browser', 'chrome', 'window', 'watch'],
              run: () => void openInChrome(),
            },
          ]
        : []),
    ],
    [onClose, live, agent.name, openInChrome]
  );

  return (
    <aside
      className="agent-preview agent-browser-pane"
      aria-label={`${agent.name}’s browser`}
      data-live={live || undefined}
    >
      <header className="agent-preview__header">
        <GlobeIcon size={14} />
        <div className="agent-preview__heading">
          <span className="agent-preview__title">{frame?.title || site}</span>
          <span className="agent-preview__where">{agent.name}’s browser</span>
        </div>
        <div className="agent-preview__header-actions">
          {live && (
            <Button
              variant="ghost"
              size="compact"
              leftIcon={<ExternalLinkIcon size={12} />}
              disabled={opening}
              onClick={() => void openInChrome()}
            >
              Open in Chrome
            </Button>
          )}
          <IconButton
            variant="ghost"
            size="compact"
            icon={<CloseIcon size={14} />}
            onClick={onClose}
            aria-label="Close the live view"
            title="Close the live view"
          />
        </div>
      </header>
      <div className="agent-preview__toolbar agent-browser-pane__toolbar">
        <span className="agent-browser-pane__address" title={frame?.url}>
          {secure && <LockedIcon size={12} />}
          <span className="agent-browser-pane__url">{frame?.url ?? site}</span>
        </span>
        <LiveMark state={live ? 'live' : 'ended'} />
      </div>
      <div className="agent-browser-pane__stage">
        <Screen frame={frame} waiting={live} className="agent-browser-pane__screen" />
        <p className="agent-browser-pane__note">
          {live
            ? `View only: ${agent.name} won’t see clicks here.`
            : frame
              ? `${agent.name} is done with this page. This is the last of it.`
              : `${agent.name} has no page open now.`}
        </p>
      </div>
    </aside>
  );
}
