/**
 * The result card (`share_result`, `agents/results.rs`): the one card an
 * agent ends a piece of work on. Title, summary, what it didn't verify (up
 * front, when it said), before/after, the files and links it produced, what
 * it checked, and the actions: Open on each item, Ask for changes on the
 * card. Drawn on the shared `AgentCard`, so it reads as the same surface as a
 * request or a copy. A project copy's card is the same card with Keep /
 * Review / Preview / Discard inside it (`ChangeCard` passes them in as
 * children), and then Ask for changes sits in that row instead.
 *
 * Only the newest version of a result is drawn in full; an older one folds to
 * a line pointing at it, and opens if you want to compare.
 *
 * Honest by construction: every list is the agent's own and is shown only
 * when it gave one. Nothing here fills a gap.
 *
 * @module components/agents/AgentResult
 */

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ChevronRightIcon,
  CloseIcon,
  CommentIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  HelpIcon,
  PlayIcon,
} from '@/components/icons';
import { useAgentPreview } from './AgentPreviewContext';
import { TestReportView } from './AgentTestReport';
import { IconButton } from '../primitives/IconButton';
import { AgentCard } from './AgentCard';
import { WorkTimeline } from './AgentWork';
import { TextButton } from '../primitives/TextButton';
import { FileGlyph, kindLabel, useAttachmentOpener } from './AgentAttachments';
import { CompareShot, ResultCompare } from './AgentCompare';
import { useImageViewer } from './AgentGallery';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { readResultCard } from '../../lib/cardShapes';
import {
  CHECKED_HEADING,
  CHECKPOINT_LABEL,
  comparePages,
  messageImages,
  changesLine,
  formatBytes,
  isImageMime,
  itemName,
  listedItems,
  revisingLabel,
  supersededLine,
  type Agent,
  type TurnWork,
  type AgentMessage,
  type ResultCard,
  type ResultItem,
  type ResultRef,
} from '../../lib/agents';

type ResultFile = Extract<ResultItem, { kind: 'file' }>['file'];

/**
 * Cards that already opened the preview by themselves: once per result,
 * however many versions follow, and never again after the user closed it.
 */
const autoOpened = new Set<string>();

/** For tests: forget which cards opened the preview. */
export function resetAutoOpened() {
  autoOpened.clear();
}

/** What "Ask for changes" hands the composer. */
export const refOf = (card: ResultCard): ResultRef => ({
  id: card.id,
  version: card.version,
  title: card.title,
});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function useLinkOpener() {
  const { showToast } = useOptionalToast();
  return (url: string) =>
    Promise.resolve()
      .then(() => openUrl(url))
      .catch((error: unknown) => showToast(formatCommandError(asCommandError(error)), 'error'));
}

function ItemRow({
  agent,
  item,
  onView,
}: {
  agent: Agent;
  item: ResultItem;
  onView: (file: ResultFile) => void;
}) {
  const openFile = useAttachmentOpener(agent.id);
  const openLink = useLinkOpener();
  const name = itemName(item);
  if (item.kind === 'file' && isImageMime(item.file.mime)) {
    return (
      <li className="agent-result__item" data-kind="image">
        <CompareShot agent={agent} file={item.file} caption={name} onView={onView} />
      </li>
    );
  }
  const meta =
    item.kind === 'file'
      ? `${kindLabel(item.file.name)} · ${formatBytes(item.file.size)}`
      : hostOf(item.url);
  return (
    <li className="agent-result__item" data-kind={item.kind}>
      <button
        type="button"
        className="agent-result__open"
        onClick={() => void (item.kind === 'file' ? openFile(item.file) : openLink(item.url))}
        title={item.kind === 'file' ? `Open ${item.file.name}` : `Open ${item.url}`}
      >
        <span className="agent-result__glyph" aria-hidden>
          {item.kind === 'file' ? <FileGlyph mime={item.file.mime} /> : <GlobeIcon size={16} />}
        </span>
        <span className="agent-result__item-text">
          <span className="agent-result__item-name">{name}</span>
          {meta !== name && <span className="agent-result__item-meta">{meta}</span>}
        </span>
        <span className="agent-result__open-word">
          Open
          <ExternalLinkIcon size={12} />
        </span>
      </button>
    </li>
  );
}

interface ResultBodyProps {
  agent: Agent;
  card: ResultCard;
}

/** Everything but the actions: shared by the live card and an older version opened up. */
function ResultBody({ agent, card }: ResultBodyProps) {
  const { view: setViewing, viewer } = useImageViewer(agent, () =>
    messageImages({ id: '', agentId: agent.id, result: card })
  );
  const pages = comparePages(card.items);
  const items = listedItems(card.items);
  const changes = changesLine(card);
  const notVerified = card.notVerified ?? [];
  const checked = card.checked ?? [];
  return (
    <>
      {changes && <p className="agent-result__changes">{changes}</p>}
      {card.summary && <p className="agent-result__summary">{card.summary}</p>}
      {notVerified.length > 0 && (
        <div className="agent-result__unverified" role="group" aria-label="Not verified">
          <h4 className="agent-result__unverified-title">
            <HelpIcon size={14} />
            Not verified
          </h4>
          <ul>
            {notVerified.map((line, i) => (
              <li key={`${i}:${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <ResultCompare agent={agent} pages={pages} onView={setViewing} />
      {items.length > 0 && (
        <ul className="agent-result__items" aria-label="What it made">
          {items.map((item, i) => (
            <ItemRow
              key={`${i}:${item.kind === 'file' ? item.file.path : item.url}`}
              agent={agent}
              item={item}
              onView={setViewing}
            />
          ))}
        </ul>
      )}
      {card.test && <TestReportView agent={agent} report={card.test} />}
      {checked.length > 0 && (
        // The agent's claims, not the app's findings: attributed, and a plain
        // bullet rather than a tick that would read as verified.
        <div className="agent-result__checked" role="group" aria-label={CHECKED_HEADING}>
          <h4 className="agent-result__checked-title">{CHECKED_HEADING}</h4>
          <ul>
            {checked.map((line, i) => (
              <li key={`${i}:${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {viewer}
    </>
  );
}

interface ResultCardViewProps {
  message: AgentMessage;
  card: ResultCard;
  agent: Agent;
  /** The newest version of this result: drawn in full, with its actions. */
  newest: boolean;
  /** Opens the composer on this result. Absent: no Ask for changes. */
  onAskForChanges?: (ref: ResultRef) => void;
  /** A project copy's part of the card (what changed, Keep / Discard…). */
  children?: ReactNode;
  /** The children carry the actions row: Ask for changes goes there instead. */
  actionsInside?: boolean;
  /** The folded "what it did" line, under the card. */
  footer?: ReactNode;
  /**
   * What the turn did, drawn as that line when there's no `footer`. Passed as
   * data rather than an element so the card's memo holds: a new element on
   * every chat render re-rendered every result card in the history.
   */
  work?: TurnWork;
  arrived?: boolean;
  /**
   * Opens the card's project (`card.project`) when the user chooses: a site
   * or app comes back as a card with Preview, never by moving the window.
   * In Agents mode Preview opens the pane beside the chat instead.
   */
  onPreview?: (projectPath: string) => void;
}

/** One result, one card. */
export const ResultCardView = memo(function ResultCardView({
  message,
  card: givenCard,
  agent,
  newest,
  onAskForChanges,
  children,
  actionsInside,
  footer: given,
  work,
  arrived,
  onPreview,
}: ResultCardViewProps) {
  // Read field by field: a part that arrived missing or odd is left out
  // rather than throwing the whole card to its fallback.
  const card = useMemo(() => readResultCard(givenCard), [givenCard]);
  const footer =
    given ??
    (work && (
      <WorkTimeline work={work} agent={agent} messageId={message.id} ownerId={message.agentId} />
    ));
  const [opened, setOpened] = useState(false);
  // Agents mode's pane beside the chat; elsewhere Preview opens the project.
  const preview = useAgentPreview();
  // Visual work that just came in shows itself: the pane opens beside the
  // chat, once per result, and only when nothing is open there already.
  const visual = Boolean(card.project) && comparePages(card.items).length > 0;
  useEffect(() => {
    if (!arrived || !newest || !visual || !preview || autoOpened.has(card.id)) return;
    autoOpened.add(card.id);
    if (!preview.isOpen()) preview.open(message.agentId, message.id);
  }, [arrived, newest, visual, preview, card.id, message.agentId, message.id]);
  if (!newest && !opened) {
    return (
      <div
        className="agent-chat__row agent-chat__row--agent agent-chat__row--card agent-chat__row--result"
        data-arrived={arrived || undefined}
        data-message-ids={message.id}
      >
        <button
          type="button"
          className="agent-result-past"
          onClick={() => setOpened(true)}
          aria-expanded={false}
        >
          <ChevronRightIcon size={12} />
          <span className="agent-result-past__text">{supersededLine(card)}</span>
        </button>
        {footer}
      </div>
    );
  }
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card agent-chat__row--result"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <AgentCard
        as="article"
        className="agent-result"
        data={{ past: !newest || undefined, unverified: (card.notVerified?.length ?? 0) > 0 }}
        aria-label={`Result: ${card.title}`}
        icon={<FileTextIcon size={14} />}
        title={card.title}
        meta={
          (card.version > 1 || !newest || card.checkpoint) && (
            <span className="agent-result__meta">
              {card.checkpoint && (
                <span className="agent-result__checkpoint">{CHECKPOINT_LABEL}</span>
              )}
              {card.version > 1 && <span className="agent-result__version">v{card.version}</span>}
              {!newest && (
                <TextButton tabIndex={0} onClick={() => setOpened(false)}>
                  Fold
                </TextButton>
              )}
            </span>
          )
        }
        // A copy's card carries its own actions row; Ask for changes is in it.
        // A change card inside (children) has its own Preview.
        actions={
          newest &&
          !actionsInside && (
            <>
              {card.project && (preview || onPreview) && !children && (
                <TextButton
                  tabIndex={0}
                  leftIcon={<GlobeIcon size={12} />}
                  onClick={() =>
                    preview ? preview.open(message.agentId, message.id) : onPreview?.(card.project!)
                  }
                >
                  Preview
                </TextButton>
              )}
              {card.project && preview && !children && (
                <TextButton
                  tabIndex={0}
                  leftIcon={<PlayIcon size={12} />}
                  onClick={() => preview.open(message.agentId, message.id, { test: true })}
                >
                  Test it
                </TextButton>
              )}
              {onAskForChanges && (
                <TextButton
                  tabIndex={0}
                  leftIcon={<CommentIcon size={12} />}
                  onClick={() => onAskForChanges(refOf(card))}
                >
                  Ask for changes
                </TextButton>
              )}
            </>
          )
        }
      >
        <ResultBody agent={agent} card={card} />
        {children}
      </AgentCard>
      {footer}
    </div>
  );
});

/** Above the composer: what the message being written asks to change. */
export function ComposerRevising({
  revising,
  onRemove,
}: {
  revising: ResultRef | null;
  onRemove: () => void;
}) {
  if (!revising) return null;
  return (
    <div className="agent-composer__revising">
      <span className="agent-quote-chip agent-result-chip">
        <CommentIcon size={12} />
        <span className="agent-quote-chip__text">{revisingLabel(revising)}</span>
        <IconButton
          variant="ghost"
          size="compact"
          className="agent-quote-chip__remove"
          icon={<CloseIcon size={12} />}
          onClick={onRemove}
          aria-label="Don't ask for changes"
          title="Don't ask for changes"
        />
      </span>
    </div>
  );
}

/** On your message: the result it asked to change. */
export function RevisesBar({ revises }: { revises: ResultRef }) {
  return (
    <span className="agent-bubble__quote agent-bubble__revises">{revisingLabel(revises)}</span>
  );
}
