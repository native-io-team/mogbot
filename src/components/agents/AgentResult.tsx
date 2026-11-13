/**
 * The result card (`share_result`, `agents/results.rs`): the one card an
 * agent ends a piece of work on. Read top to bottom:
 *
 * 1. **Header**: what was made (an icon for its kind, the title), a status
 *    pill (Finished, Partway through, Earlier version) and, once there is
 *    more than one version, a switcher (v1 · v2) that shows any version in
 *    place, for reading.
 * 2. **What changed** since the version before, in the agent's words.
 * 3. The summary, then the **media**: before and after (side by side or a
 *    slider; a phone screen in a device frame), other pictures as a small
 *    gallery, and a site's live preview with Open preview and Test it.
 * 4. Files and links as rows: a kind icon, the name, its type and size or
 *    its host, Open, and Copy link for a link.
 * 5. **Checks**: "It says it checked" beside "Not verified", one calm block.
 * 6. A project copy's **Changes are ready** footer (`ChangeCard` passes it in
 *    as children) with Keep changes / Review changes / Discard.
 * 7. **Ask for changes**: an inline composer in the card where the chat can
 *    send one (`ResultChatProvider`), else the chat's own composer.
 *
 * Only the newest version of a result is drawn in full; an older one folds to
 * a line pointing at it, and opens if you want to compare.
 *
 * Honest by construction: every list is the agent's own and is shown only
 * when it gave one. Nothing here fills a gap.
 *
 * @module components/agents/AgentResult
 */

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ArrowUpIcon,
  ChevronRightIcon,
  CloseIcon,
  CodeIcon,
  CommentIcon,
  CopyIcon,
  DesktopIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  HelpIcon,
  ImageIcon,
  PlayIcon,
} from '@/components/icons';
import { useAgentPreview } from './AgentPreviewContext';
import { TestReportView } from './AgentTestReport';
import { Prose } from './AgentProse';
import { useProseLinks } from './useProseLinks';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { StatusPill, type StatusTone } from '../primitives/StatusPill';
import { AgentCard } from './AgentCard';
import { WorkTimeline } from './AgentWork';
import { TextButton } from '../primitives/TextButton';
import { FileGlyph, kindLabel, useAttachmentOpener } from './AgentAttachments';
import { ResultCompare, ResultGallery } from './AgentCompare';
import { useImageViewer } from './AgentGallery';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { readResultCard } from '../../lib/cardShapes';
import { repeatsName } from '../../lib/resultItems';
import {
  CHECKED_HEADING,
  comparePages,
  messageImages,
  formatBytes,
  isImageMime,
  itemName,
  linkHost,
  linkKind,
  listedItems,
  RESULT_STATUS_LABEL,
  resultStatus,
  revisingLabel,
  supersededLine,
  type Agent,
  type LinkKind,
  type ResultStatus,
  type TurnWork,
  type AgentMessage,
  type ResultCard,
  type ResultItem,
  type ResultRef,
} from '../../lib/agents';
import { THIS_COMPUTER } from '../../lib/computer';

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

/**
 * What the chat lends its result cards: every version of each result (for
 * the switcher) and a way to send a request for changes from the card itself.
 * Absent (a room, a test), a card shows no switcher and Ask for changes opens
 * the chat's composer instead.
 */
interface ResultChat {
  versionsOf: (resultId: string) => ResultCard[] | undefined;
  sendChanges?: (ref: ResultRef, text: string) => void;
}

const ResultChatContext = createContext<ResultChat | null>(null);
export const ResultChatProvider = ResultChatContext.Provider;

/**
 * Inside a result card: opens its inline Ask for changes. A copy's actions
 * row (`CopyActions`) uses it, so its Ask for changes opens the same field.
 */
const ResultAskContext = createContext<(() => void) | null>(null);
export const useResultAsk = () => useContext(ResultAskContext);

const STATUS_TONE: Record<ResultStatus, StatusTone> = {
  finished: 'done',
  partway: 'running',
  earlier: 'idle',
};

function useLinkOpener() {
  const { showToast } = useOptionalToast();
  return (url: string) =>
    Promise.resolve()
      .then(() => openUrl(url))
      .catch((error: unknown) => showToast(formatCommandError(asCommandError(error)), 'error'));
}

const LINK_GLYPH: Record<LinkKind, ReactNode> = {
  local: <DesktopIcon size={16} />,
  repo: <CodeIcon size={16} />,
  doc: <FileTextIcon size={16} />,
  web: <GlobeIcon size={16} />,
};

function ItemRow({ agent, item }: { agent: Agent; item: ResultItem }) {
  const openFile = useAttachmentOpener(agent.id);
  const openLink = useLinkOpener();
  const { showToast } = useOptionalToast();
  const { copy, isCopied } = useCopyToClipboard({
    onCopy: () => showToast('Link copied', 'success'),
  });
  const name = itemName(item);
  const meta =
    item.kind === 'file'
      ? `${kindLabel(item.file.name)} · ${formatBytes(item.file.size)}`
      : linkHost(item.url);
  return (
    <li
      className="agent-result__item"
      data-kind={item.kind}
      data-link={item.kind === 'link' ? linkKind(item.url) : undefined}
    >
      <button
        type="button"
        className="agent-result__open"
        onClick={() => void (item.kind === 'file' ? openFile(item.file) : openLink(item.url))}
        title={item.kind === 'file' ? `Open ${item.file.name}` : `Open ${item.url}`}
      >
        <span className="agent-result__glyph" aria-hidden>
          {item.kind === 'file' ? (
            <FileGlyph mime={item.file.mime} />
          ) : (
            LINK_GLYPH[linkKind(item.url)]
          )}
        </span>
        <span className="agent-result__item-text">
          <span className="agent-result__item-name">{name}</span>
          {!repeatsName(meta, name) && <span className="agent-result__item-meta">{meta}</span>}
        </span>
        <span className="agent-result__open-word">
          Open
          <ExternalLinkIcon size={12} />
        </span>
      </button>
      {item.kind === 'link' && (
        <IconButton
          variant="ghost"
          size="compact"
          className="agent-result__copy"
          icon={<CopyIcon size={14} />}
          onClick={() => void copy(item.url)}
          aria-label={isCopied ? 'Copied' : `Copy link to ${name}`}
          title={isCopied ? 'Copied' : 'Copy link'}
        />
      )}
    </li>
  );
}

function Checks({ card }: { card: ResultCard }) {
  const notVerified = card.notVerified ?? [];
  const checked = card.checked ?? [];
  if (checked.length === 0 && notVerified.length === 0) return null;
  return (
    <div
      className="agent-result__checks"
      data-split={(checked.length > 0 && notVerified.length > 0) || undefined}
    >
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
    </div>
  );
}

/** Everything but the actions: shared by the live card, a version switched to and an older one opened up. */
function ResultBody({
  agent,
  card,
  preview,
}: {
  agent: Agent;
  card: ResultCard;
  /** The live preview's row: after the pictures, before the files. */
  preview?: ReactNode;
}) {
  const { view: setViewing, viewer } = useImageViewer(agent, () =>
    messageImages({ id: '', agentId: agent.id, result: card })
  );
  const pages = comparePages(card.items);
  const listed = listedItems(card.items);
  const images = listed.flatMap((item) =>
    item.kind === 'file' && isImageMime(item.file.mime)
      ? [{ file: item.file, caption: itemName(item) }]
      : []
  );
  const rows = listed.filter((item) => !(item.kind === 'file' && isImageMime(item.file.mime)));
  const changes = card.version > 1 ? card.changes?.trim() : undefined;
  const onProseClick = useProseLinks(agent.id);
  return (
    <>
      {changes && (
        <div className="agent-result__changes" role="note">
          <span className="agent-result__changes-title">Changes since v{card.version - 1}</span>
          <p className="agent-result__changes-text">{changes}</p>
        </div>
      )}
      {/* Markdown, as a reply is: a table in it scrolls sideways in its own
          frame (agents-chat.css) instead of arriving as rows of pipes. */}
      {card.summary && (
        <div className="agent-result__summary agent-markdown" onClick={onProseClick}>
          <Prose text={card.summary} />
        </div>
      )}
      {/* The work first; what it checked and what it didn't come after it,
          together, so the caveats are read beside the claims they qualify. */}
      <ResultCompare agent={agent} pages={pages} onView={setViewing} />
      <ResultGallery agent={agent} images={images} onView={setViewing} />
      {preview}
      {rows.length > 0 && (
        <ul className="agent-result__items" aria-label="What it made">
          {rows.map((item, i) => (
            <ItemRow
              key={`${i}:${item.kind === 'file' ? item.file.path : item.url}`}
              agent={agent}
              item={item}
            />
          ))}
        </ul>
      )}
      {card.test && <TestReportView agent={agent} report={card.test} />}
      <Checks card={card} />
      {viewer}
    </>
  );
}

const projectName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** A site's live preview: where it runs, and the two ways in. */
function PreviewPanel({
  project,
  onOpen,
  onTest,
}: {
  project: string;
  onOpen: () => void;
  onTest?: () => void;
}) {
  return (
    <div className="agent-result__preview" role="group" aria-label="Live preview">
      <span className="agent-result__preview-tile" aria-hidden>
        <GlobeIcon size={16} />
      </span>
      <span className="agent-result__preview-text">
        <span className="agent-result__preview-title">Live preview</span>
        <span className="agent-result__preview-meta">
          {projectName(project)} · runs on {THIS_COMPUTER}
        </span>
      </span>
      <span className="agent-result__preview-actions">
        {onTest && (
          <Button variant="secondary" leftIcon={<PlayIcon size={12} />} onClick={onTest}>
            Test it
          </Button>
        )}
        <Button variant="strong" leftIcon={<GlobeIcon size={14} />} onClick={onOpen}>
          Open preview
        </Button>
      </span>
    </div>
  );
}

/** Ask for changes, in the card: one field, sent as a request to revise this result. */
function AskComposer({
  card,
  onSend,
  onClose,
}: {
  card: ResultCard;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  const send = () => {
    const typed = text.trim();
    if (!typed) return;
    onSend(typed);
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  return (
    <form
      className="agent-result-ask"
      aria-label={revisingLabel(refOf(card))}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label className="agent-result-ask__label">
        <CommentIcon size={12} />
        <span>{revisingLabel(refOf(card))}</span>
        <textarea
          ref={field}
          className="agent-result-ask__input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`What should v${card.version + 1} change?`}
        />
      </label>
      <div className="agent-result-ask__actions">
        <TextButton tabIndex={0} onClick={onClose}>
          Cancel
        </TextButton>
        <Button
          type="submit"
          variant="strong"
          disabled={!text.trim()}
          leftIcon={<ArrowUpIcon size={14} />}
        >
          Send
        </Button>
      </div>
    </form>
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

/** The header's icon: what kind of thing was made. */
function kindIcon(card: ResultCard, hasCopy: boolean) {
  if (card.project || hasCopy) return <GlobeIcon size={14} />;
  const pictures = (card.items ?? []).some((i) => i.kind === 'file' && isImageMime(i.file.mime));
  return pictures ? <ImageIcon size={14} /> : <FileTextIcon size={14} />;
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
  const [asking, setAsking] = useState(false);
  const chat = useContext(ResultChatContext);
  const versions = newest ? chat?.versionsOf(card.id) : undefined;
  const [shownVersion, setShownVersion] = useState<number | null>(null);
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
  const status = resultStatus(card, newest);
  // A version switched to, for reading; the card's actions stay the newest's.
  const shown =
    (shownVersion !== null && versions?.find((v) => v.version === shownVersion)) || card;
  const switcher = versions && versions.length > 1;
  // Ask in the card when the chat can send it; else the chat's composer.
  const inline = Boolean(newest && chat?.sendChanges && onAskForChanges);
  const ask =
    onAskForChanges && newest
      ? () => (inline ? setAsking(true) : onAskForChanges(refOf(card)))
      : null;
  const canPreview = Boolean(card.project && (preview || onPreview) && !children && newest);
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card agent-chat__row--result"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <AgentCard
        as="article"
        className="agent-result"
        data={{
          past: !newest || undefined,
          unverified: (shown.notVerified?.length ?? 0) > 0,
          status,
          'copy-inside': Boolean(children) || undefined,
        }}
        aria-label={`Result: ${card.title}`}
        icon={<span className="agent-result__kind">{kindIcon(card, Boolean(children))}</span>}
        title={card.title}
        meta={
          <span className="agent-result__meta">
            <StatusPill tone={STATUS_TONE[status]} className="agent-result__status">
              {RESULT_STATUS_LABEL[status]}
            </StatusPill>
            {switcher ? (
              <SegmentedControl
                size="compact"
                className="agent-result__versions"
                aria-label="Version"
                value={String(shown.version)}
                onValueChange={(v) =>
                  setShownVersion(Number(v) === card.version ? null : Number(v))
                }
                options={versions.map((v) => ({
                  value: String(v.version),
                  label: `v${v.version}`,
                }))}
              />
            ) : (
              card.version > 1 && <span className="agent-result__version">v{card.version}</span>
            )}
            {!newest && (
              <TextButton tabIndex={0} onClick={() => setOpened(false)}>
                Fold
              </TextButton>
            )}
          </span>
        }
        // A copy's card carries its own actions row; Ask for changes is in it.
        actions={
          ask &&
          !actionsInside &&
          !asking && (
            <TextButton tabIndex={0} leftIcon={<CommentIcon size={12} />} onClick={ask}>
              Ask for changes
            </TextButton>
          )
        }
      >
        {shown !== card && (
          <p className="agent-result__reading" role="status">
            Reading v{shown.version}, an earlier version.{' '}
            <TextButton tabIndex={0} onClick={() => setShownVersion(null)}>
              Back to v{card.version}
            </TextButton>
          </p>
        )}
        <ResultBody
          key={shown.version}
          agent={agent}
          card={shown}
          preview={
            canPreview && (
              <PreviewPanel
                project={card.project!}
                onOpen={() =>
                  preview ? preview.open(message.agentId, message.id) : onPreview?.(card.project!)
                }
                onTest={
                  preview
                    ? () => preview.open(message.agentId, message.id, { test: true })
                    : undefined
                }
              />
            )
          }
        />
        {asking && chat?.sendChanges && (
          <AskComposer
            card={card}
            onSend={(text) => chat.sendChanges?.(refOf(card), text)}
            onClose={() => setAsking(false)}
          />
        )}
        <ResultAskContext.Provider value={ask}>{children}</ResultAskContext.Provider>
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
