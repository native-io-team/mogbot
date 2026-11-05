/**
 * The result card (`share_result`, `agents/results.rs`): the one card an
 * agent ends a piece of work on. Title, summary, what it didn't verify (up
 * front, when it said), before/after, the files and links it produced, what
 * it checked, and the actions: Open on each item, Ask for changes on the
 * card. A project copy's card is the same card with Keep / Review / Preview /
 * Discard inside it (`ChangeCard` passes them in as children).
 *
 * Only the newest version of a result is drawn in full; an older one folds to
 * a line pointing at it, and opens if you want to compare.
 *
 * Honest by construction: every list is the agent's own and is shown only
 * when it gave one. Nothing here fills a gap.
 *
 * @module components/agents/AgentResult
 */

import { memo, useState, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CommentIcon,
  ExternalLinkIcon,
  GlobeIcon,
  WarningIcon,
} from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { AttachmentLightbox, FileGlyph, kindLabel, useAttachmentOpener } from './AgentAttachments';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  attachmentUrl,
  beforeAfter,
  changesLine,
  formatBytes,
  isImageMime,
  itemName,
  listedItems,
  revisingLabel,
  supersededLine,
  type Agent,
  type AgentMessage,
  type Attachment,
  type ResultCard,
  type ResultItem,
  type ResultRef,
} from '../../lib/agents';

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

function Shot({
  agent,
  file,
  caption,
  onView,
}: {
  agent: Agent;
  file: Attachment;
  caption: string;
  onView: (file: Attachment) => void;
}) {
  return (
    <figure className="agent-result__shot">
      <button
        type="button"
        className="agent-result__shot-image"
        onClick={() => onView(file)}
        aria-label={`View ${caption}: ${file.name}`}
        title={file.name}
      >
        <img src={attachmentUrl(agent.home, file)} alt={file.name} loading="lazy" />
      </button>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function ItemRow({
  agent,
  item,
  onView,
}: {
  agent: Agent;
  item: ResultItem;
  onView: (file: Attachment) => void;
}) {
  const openFile = useAttachmentOpener(agent.id);
  const openLink = useLinkOpener();
  const name = itemName(item);
  if (item.kind === 'file' && isImageMime(item.file.mime)) {
    return (
      <li className="agent-result__item" data-kind="image">
        <Shot agent={agent} file={item.file} caption={name} onView={onView} />
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
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const pair = beforeAfter(card.items);
  const items = listedItems(card.items);
  const changes = changesLine(card);
  const notVerified = card.notVerified ?? [];
  const checked = card.checked ?? [];
  return (
    <>
      {changes && <p className="agent-result__changes">{changes}</p>}
      {card.summary && <p className="agent-result__summary">{card.summary}</p>}
      {notVerified.length > 0 && (
        <section className="agent-result__unverified" aria-label="Not verified">
          <h4 className="agent-result__unverified-title">
            <WarningIcon size={14} />
            Not verified
          </h4>
          <ul>
            {notVerified.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      {pair && (
        <div className="agent-result__pair" aria-label="Before and after">
          <Shot agent={agent} file={pair.before} caption="Before" onView={setViewing} />
          <Shot agent={agent} file={pair.after} caption="After" onView={setViewing} />
        </div>
      )}
      {items.length > 0 && (
        <ul className="agent-result__items" aria-label="What it made">
          {items.map((item) => (
            <ItemRow
              key={item.kind === 'file' ? item.file.path : item.url}
              agent={agent}
              item={item}
              onView={setViewing}
            />
          ))}
        </ul>
      )}
      {checked.length > 0 && (
        <section className="agent-result__checked" aria-label="Checked">
          <h4 className="agent-result__checked-title">Checked</h4>
          <ul>
            {checked.map((line) => (
              <li key={line}>
                <CheckIcon size={12} />
                {line}
              </li>
            ))}
          </ul>
        </section>
      )}
      <AttachmentLightbox agent={agent} viewing={viewing} onClose={() => setViewing(null)} />
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
  arrived?: boolean;
}

/** One result, one card. */
export const ResultCardView = memo(function ResultCardView({
  message,
  card,
  agent,
  newest,
  onAskForChanges,
  children,
  actionsInside,
  footer,
  arrived,
}: ResultCardViewProps) {
  const [opened, setOpened] = useState(false);
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
      <article
        className="agent-result"
        data-past={!newest || undefined}
        data-unverified={(card.notVerified?.length ?? 0) > 0 || undefined}
        aria-label={`Result: ${card.title}`}
      >
        <header className="agent-result__head">
          <h3 className="agent-result__title">{card.title}</h3>
          {card.version > 1 && <span className="agent-result__version">v{card.version}</span>}
          {!newest && (
            <TextButton tabIndex={0} onClick={() => setOpened(false)}>
              Fold
            </TextButton>
          )}
        </header>
        <ResultBody agent={agent} card={card} />
        {children}
        {newest && onAskForChanges && !actionsInside && (
          <div className="agent-result__actions">
            <TextButton
              tabIndex={0}
              leftIcon={<CommentIcon size={12} />}
              onClick={() => onAskForChanges(refOf(card))}
            >
              Ask for changes
            </TextButton>
          </div>
        )}
      </article>
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
