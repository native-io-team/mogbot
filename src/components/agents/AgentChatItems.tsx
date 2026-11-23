/**
 * The pieces a conversation is made of: bubbles, the centred lines where
 * agents talked to each other, approval cards, errors and time dividers.
 *
 * @module components/agents/AgentChatItems
 */

import { AgentDraftCard } from './AgentDraftCard';
import { planScope, plainApprovalTitle } from '../../lib/approvalTitle';
import { draftOf } from '../../lib/draftCard';
import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { GrowingProse, Prose } from './AgentProse';
import { useStreamIn } from './useStreamIn';
import { TypingDots } from '../primitives/TypingDots';
import { agentIn, useAgentsSelector } from '../../lib/agentsStore';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ChevronRightIcon,
  CommentIcon,
  CopyIcon,
  DownloadIcon,
  GlobeIcon,
  GraduationCapIcon,
  ErrorIcon,
  FolderIcon,
  HistoryIcon,
  RoutineIcon,
  MoreHorizontalIcon,
  PinIcon,
  ReplyIcon,
  SettingsSlidersIcon,
  ShieldCheckIcon,
  WarningIcon,
} from '@/components/icons';
import { Button } from '../primitives/Button';
import { approvalKey } from './approvalKeys';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import { TextField } from '../primitives/TextField';
import { Tooltip } from '../primitives/Tooltip';
import { ComposerAttachments, MessageAttachments } from './AgentAttachments';
import { LocalLinks } from './AgentLocalLinks';
import type { DraftAttachment } from './useComposerAttachments';
import { MentionText } from './AgentMentions';
import { canReplyTo } from '../../lib/replyTo';
import { ReplyPill, useReply } from './ReplyContext';
import {
  GO_BACK_ICONS_SM,
  GO_BACK_ORDER,
  GoBackContextMenu,
  type GoBackAction,
  type GoBackState,
} from './AgentGoBack';
import { GO_BACK_LABELS, goBackBlocked } from '../../../packages/companion-protocol/src/rewind';
import { AgentPeerStatus } from './AgentPeerStatus';
import { SecretCard } from './AgentSecretCard';
import { LoginCard } from './AgentLoginCard';
import { CrossoverCard } from './AgentCrossoverCard';
import {
  answeredWords,
  cantAlwaysAllow,
} from '../../../packages/companion-protocol/src/answeredFrom';
import {
  checkInHead,
  STEP_IN_RETIRED_LINE,
} from '../../../packages/companion-protocol/src/cardWords';
import { viaLabel } from '../../../packages/companion-protocol/src/model';
import { AgentSettingsChange } from './AgentSettingsChange';
import { AgentSkillCardBody } from './AgentSkills';
import {
  SKILL_NOT_NOW,
  SKILL_OFFER_NOTE,
  SKILL_SAVE,
  skillOutcome,
} from '../../../packages/companion-protocol/src/skills';
import { readPlan } from '../../lib/cardShapes';
import { AgentPlanList } from './AgentPlanList';
import { AgentGateBody } from './AgentRoutineSteps';
import { AgentCard } from './AgentCard';
import { ApprovalFallback } from './AgentApprovalFallback';
import { AreaBoundary } from '../primitives/AreaBoundary';
import { ImportReviewCard } from './ImportReviewCard';
import { ImportPlaybackCard } from './ImportPlaybackCard';
import { WorkTimeline } from './AgentWork';
export { WorkingIndicator } from './AgentWorkingIndicator';
import { RevisesBar } from './AgentResult';
import { AgentBlocks } from './blocks/AgentBlocks';
import {
  attachmentsOutsideBlocks,
  readBlocks,
} from '../../../packages/companion-protocol/src/blocks';
import { NoteFixLine } from './AgentNoteFix';
import { useOptionalToast } from '../../contexts/ToastContext';
import { requestSwitcher, switcherMounted } from '../../lib/agentAccounts';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useHeightReveal } from './useAgentMotion';
import { useCardGuard } from './useCardGuard';
import { useProseLinks } from './useProseLinks';
import { ProseImages, useProsePaths } from './useProsePaths';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import {
  connectorTextParts,
  GATE_ALLOW,
  GATE_DENY,
  CONTEXT_SUGGEST_AT,
  contextPercent,
  describeScope,
  ENGINE_LABEL,
  errorRemedy,
  failureFixLabel,
  expiryLine,
  folderName,
  formatClock,
  retryPhrase,
  formatDivider,
  formatExactTime,
  peerGroupLabel,
  revokePermission,
  splitQuotes,
  type Agent,
  type AgentEngine,
  type AgentMessage,
  type AgentRef,
  type Approval,
  type SessionPrompt,
} from '../../lib/agents';

/**
 * `arrived` marks a line that came in while the chat was open, so only it
 * rises into place (features/agents-motion.css); history loads still.
 */
interface Arrival {
  arrived?: boolean;
}

/**
 * The time under a message, on hover or keyboard focus, keeping its space so
 * nothing shifts under the pointer; the exact time is its tooltip. Copy and
 * the rest are in the message's ⋯ (`MessageMenu`), and ⌘C copies a focused
 * message (`copyOnKey`).
 */
function MessageActions({ ts }: { ts: number }) {
  return (
    <div className="agent-message__actions">
      <time
        className="agent-message__time"
        dateTime={new Date(ts).toISOString()}
        title={formatExactTime(ts)}
      >
        {formatClock(ts)}
      </time>
    </div>
  );
}

/**
 * The one hover control (spec-message-hover.md): a quiet ⋯ beside the bubble,
 * level with its first line, on the outside edge (left of yours, right of the
 * agent's). It opens the message's menu beside it, in words: Copy, Reply,
 * Edit and resend, Fork from here, Rewind to here, Remember this, each only
 * where it applies. Open, the ⋯ only brightens: no circle, no box. A Tab stop
 * (Enter opens, Esc closes and gives focus back); the same rows are on a
 * right-click of your own message.
 */
function MessageMenu({
  side,
  text,
  onReply,
  onRemember,
  goBack,
}: {
  side: 'user' | 'agent';
  text: string;
  onReply?: () => void;
  onRemember?: () => void;
  goBack?: { state: GoBackState; onPick: (action: GoBackAction) => void };
}) {
  const { copy } = useCopyToClipboard();
  const reason = goBack ? goBackBlocked('rewind', goBack.state) : null;
  if (!text && !onReply && !goBack) return null;
  return (
    <div className="agent-message__tools" data-side={side}>
      <Dropdown
        align={side === 'user' ? 'right' : 'left'}
        side={side === 'user' ? 'left' : 'right'}
        portal
        quietOpen
        boundary=".agent-chat"
        menuClassName="agent-message__menu"
        trigger={(p) => (
          <IconButton
            {...p}
            tabIndex={0}
            variant="ghost"
            size="compact"
            className="agent-message__more"
            icon={<MoreHorizontalIcon size={16} />}
            aria-label="Message actions"
            title="More"
          />
        )}
      >
        {text && (
          <DropdownItem icon={<CopyIcon size={12} />} onSelect={() => void copy(text)}>
            Copy
          </DropdownItem>
        )}
        {onReply && (
          <DropdownItem icon={<ReplyIcon size={12} />} onSelect={onReply}>
            Reply
          </DropdownItem>
        )}
        {goBack && (
          <>
            <DropdownDivider />
            {GO_BACK_ORDER.map((action) => (
              <DropdownItem
                key={action}
                icon={GO_BACK_ICONS_SM[action]}
                disabled={goBackBlocked(action, goBack.state) !== null}
                onSelect={() => goBack.onPick(action)}
              >
                {GO_BACK_LABELS[action]}
              </DropdownItem>
            ))}
            {reason && <p className="agent-go-back__reason">{reason}</p>}
          </>
        )}
        {text && onRemember && (
          <>
            <DropdownDivider />
            <DropdownItem icon={<PinIcon size={12} />} onSelect={onRemember}>
              Remember this
            </DropdownItem>
          </>
        )}
      </Dropdown>
    </div>
  );
}

/**
 * ⌘C on a focused message with nothing selected copies the whole message, as
 * its Copy button would.
 */
function useCopyOnKey(textOf: string | (() => string), onReply?: () => void) {
  const { copy } = useCopyToClipboard();
  const reply = useReply();
  return (event: React.KeyboardEvent<HTMLElement>) => {
    // R replies to the focused message; Esc drops the reply that is set.
    if (event.target === event.currentTarget && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key.toLowerCase() === 'r' && onReply) {
        event.preventDefault();
        onReply();
        return;
      }
      if (event.key === 'Escape' && reply) reply.cancel();
    }
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'c') return;
    const text = typeof textOf === 'function' ? textOf() : textOf;
    if (!text) return;
    if (event.target !== event.currentTarget) return;
    if (window.getSelection()?.toString()) return;
    event.preventDefault();
    void copy(text);
  };
}

interface AgentBubbleProps extends Arrival {
  message: AgentMessage;
  /** Whose reply: local paths resolve against its home, shared files live there. */
  agent: Agent;
  /** "Remember this", with this message. */
  onRemember?: (message: AgentMessage) => void;
  /** One of the Chief's scripted lines: it types itself out when first seen (`useStreamIn`). */
  scripted?: boolean;
}

/** A reply in prose, and any files the agent shared with it (`share_file`). */
export const AgentBubble = memo(function AgentBubble({
  message,
  agent,
  arrived,
  onRemember,
  scripted,
}: AgentBubbleProps) {
  const onClick = useProseLinks(agent.id);
  const streamIn = useStreamIn(message.id, message.text, message.ts, !!scripted);
  // Blocks (`show`) draw in place of the text, which is their plain version.
  const blocks = readBlocks(message);
  // Paths in the finished reply: images drawn under it, the rest marked.
  const proseRef = useRef<HTMLDivElement>(null);
  const pathImages = useProsePaths(
    agent.id,
    proseRef,
    streamIn.phase === 'done' && !blocks ? message.text : ''
  );
  const attachments = attachmentsOutsideBlocks(message.attachments, blocks);
  // Files it shared, or images its words name: under the reply, actions beside.
  const pictures = attachments.length > 0 || pathImages.length > 0;
  const replies = useReply();
  const onReply = replies && canReplyTo(message) ? () => replies.reply(message) : undefined;
  const actions = <MessageActions ts={message.ts} />;
  // The ⋯ beside the bubble, on its outside edge.
  const tools = (
    <MessageMenu
      side="agent"
      text={message.text}
      onReply={onReply}
      onRemember={onRemember && message.text ? () => onRemember(message) : undefined}
    />
  );
  // Still being written: its words live in the store, not in this message.
  const onKeyDown = useCopyOnKey(message.text, onReply);
  if (streamIn.phase !== 'done') {
    return (
      <div
        className="agent-chat__row agent-chat__row--agent"
        data-arrived={arrived || undefined}
        data-message-ids={message.id}
        data-stream-in={streamIn.phase}
      >
        <div className="agent-bubble agent-bubble--agent agent-markdown" aria-busy>
          {streamIn.phase === 'typing' || streamIn.phase === 'waiting' ? (
            <TypingDots label={`${agent.name} is typing`} />
          ) : (
            <GrowingProse text={streamIn.shown} />
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="agent-chat__row agent-chat__row--agent"
      data-arrived={arrived || undefined}
      data-stopped={message.stopped || undefined}
      data-actions={!pictures || undefined}
      data-attachments={pictures || undefined}
      data-local-links={(message.localLinks?.length ?? 0) > 0 || undefined}
      data-blocks={blocks ? true : undefined}
      data-work={message.work ? true : undefined}
      data-message-ids={message.id}
    >
      {blocks ? (
        <div className="agent-blocks__frame" onClick={onClick}>
          <AgentBlocks messageId={message.id} agent={agent} set={blocks} />
        </div>
      ) : (
        message.text && (
          <div
            ref={proseRef}
            className="agent-bubble agent-bubble--agent agent-markdown"
            onClick={onClick}
          >
            <Prose text={message.text} />
            {tools}
          </div>
        )
      )}
      {message.stopped && <span className="agent-bubble__stopped">Stopped</span>}
      <LocalLinks message={message} />
      {pictures ? (
        <div className="agent-chat__line agent-chat__line--agent">
          <ProseImages agentId={agent.id} images={pathImages} />
          {attachments.length > 0 && (
            <MessageAttachments agent={agent} attachments={attachments} side="agent" />
          )}
          {actions}
        </div>
      ) : (
        actions
      )}
      {message.work && (
        <WorkTimeline
          work={message.work}
          agent={agent}
          messageId={message.id}
          ownerId={message.agentId}
        />
      )}
    </div>
  );
});

interface UserBubbleProps extends Arrival {
  message: AgentMessage;
  /** Whose home the attachments live in. */
  agent: Agent;
  /** Sending failed; offer to try again. */
  failed?: boolean;
  /** Called with this message's id. */
  onRetry?: (id: string) => void;
  /** An agent's colour, for tinting the names you @mentioned. */
  colorwayOf: (agentId: string) => string | undefined;
  /**
   * The newest message waiting for the turn in progress to end. It says so,
   * and offers to interrupt that turn to send it now.
   */
  queued?: boolean;
  /** Queued, and already handed to the turn in progress: it reads it at its next step. */
  handed?: boolean;
  /** Read by the turn in progress, mid-turn. */
  heard?: boolean;
  onInterrupt?: () => void;
  /** You're driving the agent's session: it waits for the hand-back, and nothing interrupts. */
  driven?: boolean;
  /** Still copying its files in: the files as staged, shown while it sends. */
  sending?: DraftAttachment[];
  /** Sent while dictation was still tidying its words: dimmed, "Tidying…", it goes once they're in. */
  tidying?: boolean;
  /** "Remember this", with this message. */
  onRemember?: (message: AgentMessage) => void;
  /** Edit and resend, Fork from here, Rewind to here: what blocks them, and the pick. */
  goBack?: GoBackState;
  onGoBack?: (action: GoBackAction, message: AgentMessage) => void;
}

/** The held voice message's bars, as heights 0..1. */
const VOICE_BARS = [0.3, 0.55, 0.8, 0.45, 0.95, 0.6, 0.35, 0.7, 1, 0.5, 0.75, 0.4, 0.6, 0.3];

/** Attachments sit above the words, both against the right edge, as one message. */
export const UserBubble = memo(function UserBubble({
  message,
  agent,
  arrived,
  failed,
  onRetry,
  colorwayOf,
  queued,
  handed,
  heard,
  onInterrupt,
  driven,
  sending,
  tidying,
  onRemember,
  goBack,
  onGoBack,
}: UserBubbleProps) {
  const attachments = message.attachments ?? [];
  const replies = useReply();
  const onReply =
    replies && !failed && !sending && !tidying && canReplyTo(message)
      ? () => replies.reply(message)
      : undefined;
  const actions = !failed && !sending && !tidying && <MessageActions ts={message.ts} />;
  const tools = !failed && !sending && !tidying && (
    <MessageMenu
      side="user"
      text={message.text}
      onReply={onReply}
      onRemember={onRemember && (() => onRemember(message))}
      goBack={
        goBack && onGoBack
          ? { state: goBack, onPick: (action) => onGoBack(action, message) }
          : undefined
      }
    />
  );
  const onKeyDown = useCopyOnKey(message.text, onReply);
  const bubble = (
    <div className="agent-bubble agent-bubble--user">
      {message.revises && <RevisesBar revises={message.revises} />}
      {tidying && !message.text.trim() && (
        // Sent before its words were written out: your voice, until they are.
        <span className="agent-bubble__wave" role="img" aria-label="What you said">
          {VOICE_BARS.map((h, i) => (
            <span key={i} style={{ '--bar': h } as CSSProperties} />
          ))}
        </span>
      )}
      {splitQuotes(message.text).map((part, i) =>
        part.kind === 'quote' ? (
          <blockquote key={i} className="agent-bubble__quote">
            {part.text}
          </blockquote>
        ) : (
          <p key={i} className="agent-bubble__text">
            <MentionText text={part.text} mentions={message.mentions} colorwayOf={colorwayOf} />
          </p>
        )
      )}
    </div>
  );
  // Written in Slack, not here: "From Slack · #launch".
  const via = viaLabel(message.via);
  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="agent-chat__row agent-chat__row--user"
      data-arrived={arrived || undefined}
      data-failed={failed || undefined}
      data-sending={sending || tidying ? '' : undefined}
      aria-busy={sending || tidying ? true : undefined}
      data-attachments={attachments.length > 0 || Boolean(sending?.length) || undefined}
      data-message-ids={message.id}
    >
      {sending && sending.length > 0 && (
        <div className="agent-chat__line">
          <ComposerAttachments items={sending} />
        </div>
      )}
      {attachments.length > 0 && (
        <div className="agent-chat__line">
          {!message.text && actions}
          <MessageAttachments agent={agent} attachments={attachments} />
        </div>
      )}
      {message.replyTo && replies && (
        <ReplyPill replyTo={message.replyTo} otherParty={agent.name} />
      )}
      {(message.text || tidying) && (
        <div className="agent-chat__line">
          {actions}
          {tools}
          {goBack && onGoBack && !failed && !sending && !tidying ? (
            <GoBackContextMenu
              state={goBack}
              text={message.text}
              onReply={onReply}
              onPick={(action) => onGoBack(action, message)}
              onRemember={onRemember && (() => onRemember(message))}
            >
              {bubble}
            </GoBackContextMenu>
          ) : (
            bubble
          )}
        </div>
      )}
      {via && <div className="agent-chat__queued">{via}</div>}
      {tidying ? (
        <div className="agent-chat__queued" role="status">
          Tidying…
        </div>
      ) : (
        sending && (
          <div className="agent-chat__queued" role="status">
            Sending…
          </div>
        )
      )}
      {queued && !failed && driven && (
        <div className="agent-chat__queued" role="status">
          Waiting for you to hand {agent.name} back
        </div>
      )}
      {heard && !failed && (
        <div className="agent-chat__queued" role="status">
          Read
        </div>
      )}
      {queued && handed && !failed && !driven && (
        <div className="agent-chat__queued" role="status">
          Next
        </div>
      )}
      {queued && !handed && !failed && !driven && (
        <div className="agent-chat__queued" role="status">
          Next
          <span aria-hidden>·</span>
          <TextButton
            tabIndex={0}
            onClick={onInterrupt}
            title="Stop what it’s doing and send this now (⌘↵ when sending)"
          >
            Send now
          </TextButton>
        </div>
      )}
      {failed && (
        <div className="agent-chat__failed" role="alert">
          <WarningIcon size={12} />
          Not sent.
          <TextButton variant="strong" tabIndex={0} onClick={() => onRetry?.(message.id)}>
            Try again
          </TextButton>
        </div>
      )}
    </div>
  );
});

interface ErrorLineProps extends Arrival {
  message: AgentMessage;
  /** Send the last thing you said again; only on the newest failure. */
  onRetry?: () => void;
  /** A usage limit with a reset time Claude Code reported: retry then. */
  onRetryAt?: (at: number) => void | Promise<void>;
  /** A retry already waits for that reset (a check-in at that time). */
  retryScheduled?: boolean;
  onSignIn?: () => void;
  /** Its engine isn't on this Mac: set it up again (Install …). */
  onInstall?: () => void;
  /** What the agent runs on, which "Sign in to …" names. */
  engine?: AgentEngine;
  /** Whose home a timeline's screenshots live in; without it, no timeline. */
  agent?: Agent;
}

/**
 * A failed turn, with its one next step: sign in again, or try again (now,
 * or when the usage limit resets). A usage limit is expected and heals on its
 * own, so it reads as a notice, not an alarm.
 */
export const ErrorLine = memo(function ErrorLine({
  message,
  arrived,
  onRetry,
  onRetryAt,
  retryScheduled,
  onSignIn,
  onInstall,
  engine = 'claude',
  agent,
}: ErrorLineProps) {
  const remedy = errorRemedy(message);
  const signIn = remedy === 'sign-in' && onSignIn;
  const install = remedy === 'install' && onInstall;
  const resetsAt = message.failure?.kind === 'usage_limit' ? message.failure.resetsAt : undefined;
  // Offered only while the reset is still ahead (as of when the line was shown).
  const [shownAt] = useState(Date.now);
  const retryAt = onRetry && resetsAt && resetsAt > shownAt ? resetsAt : undefined;
  // One check-in per click, however fast the second click comes.
  const [scheduling, setScheduling] = useState(false);
  const schedulingRef = useRef(false);
  const scheduleRetry = (at: number) => {
    if (schedulingRef.current) return;
    schedulingRef.current = true;
    setScheduling(true);
    void Promise.resolve(onRetryAt?.(at)).finally(() => {
      schedulingRef.current = false;
      setScheduling(false);
    });
  };
  const onKeyDown = useCopyOnKey(message.text);
  const limited = message.failure?.kind === 'usage_limit';
  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-limit={limited || undefined}
      data-failed={!limited || undefined}
      data-actions
      data-arrived={arrived || undefined}
      data-work={message.work && agent ? true : undefined}
      data-message-ids={message.id}
    >
      {limited ? (
        // A usage limit heals by itself: a Line, with its one text action.
        <div className="agent-bubble--error agent-limit" data-failure="usage_limit" role="status">
          <ErrorText message={message} />
          {retryAt &&
            (retryScheduled ? (
              <span className="agent-bubble__scheduled">
                <HistoryIcon size={12} />
                Retries {retryPhrase(retryAt)}
              </span>
            ) : (
              // Neutral ink, never the agent's colour: on a status line a red
              // or green agent's accent read as an error or a success.
              <TextButton
                tabIndex={0}
                variant="strong"
                disabled={scheduling}
                aria-busy={scheduling || undefined}
                onClick={() => scheduleRetry(retryAt)}
              >
                {scheduling ? 'Scheduling…' : `Retry ${retryPhrase(retryAt)}`}
              </TextButton>
            ))}
          {/* Retry at the reset is the recommended one; "Try now" stays
              beside it, quiet, because the limit may already have lifted
              (another plan, extra usage). Once the reset has passed, Retry. */}
          {onRetry && (
            <TextButton tabIndex={0} variant={retryAt ? 'default' : 'strong'} onClick={onRetry}>
              {retryAt ? 'Try now' : 'Retry'}
            </TextButton>
          )}
          {/* The moment another account is worth having, so onboarding
              doesn't ask for one up front: the account row's own "Add". */}
          {switcherMounted() && (
            <TextButton tabIndex={0} onClick={() => requestSwitcher('add')} data-add-account>
              Add another account
            </TextButton>
          )}
        </div>
      ) : (
        // A real failure: a card, with a red mark (not only a red hue) and
        // its next step on the right.
        <div
          className="agent-card agent-bubble--error"
          data-failure={message.failure?.kind}
          role="alert"
        >
          <div className="agent-bubble__error-text">
            <ErrorIcon size={14} className="inline-error-icon" />
            <ErrorText message={message} />
          </div>
          {(signIn || install || onRetry) && (
            <div className="agent-card__actions">
              {onRetry && (
                <Button
                  tabIndex={0}
                  variant={signIn || install ? 'ghost' : 'secondary'}
                  onClick={onRetry}
                >
                  {failureFixLabel(
                    message.failure?.kind === 'interrupted' ? 'continue' : 'retry',
                    ENGINE_LABEL[engine]
                  )}
                </Button>
              )}
              {signIn && (
                <Button tabIndex={0} variant="secondary" onClick={onSignIn}>
                  {failureFixLabel('sign-in', ENGINE_LABEL[engine])}
                </Button>
              )}
              {install && (
                <Button tabIndex={0} variant="secondary" onClick={onInstall} data-fix="install">
                  {failureFixLabel('install', ENGINE_LABEL[engine])}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <MessageActions ts={message.ts} />
      {message.work && agent && (
        <WorkTimeline
          work={message.work}
          agent={agent}
          messageId={message.id}
          ownerId={message.agentId}
        />
      )}
    </div>
  );
});

/**
 * A take-over's terminal that closed by itself quotes its last lines after a
 * blank line (`takeover::early_exit_line`): the sentence, and the lines as
 * the terminal showed them. `null` for any other message.
 */
function screenTail(message: AgentMessage): [string, string] | null {
  const at = message.takeover ? message.text.indexOf('\n\n') : -1;
  return at < 0 ? null : [message.text.slice(0, at), message.text.slice(at + 2)];
}

/** An error's words (an older build wrote a take-over's early exit as one). */
function ErrorText({ message }: { message: AgentMessage }) {
  const tail = screenTail(message);
  if (!tail) return <p className="agent-bubble__text">{message.text}</p>;
  return (
    <>
      <p className="agent-bubble__text">{tail[0]}</p>
      <pre className="agent-bubble__screen">{tail[1]}</pre>
    </>
  );
}

/**
 * "Scheduled" (one-time) or "Routine" (repeating), centred like the agent-to-agent lines, with the note
 * the agent left itself. A late one says so: the app was closed when it was due.
 * One you ran from the schedule popover says that instead.
 */
export const CheckInLine = memo(function CheckInLine({
  message,
  arrived,
}: { message: AgentMessage } & Arrival) {
  // Worded once for the desk and the phone (`checkInHead`).
  const [label, ...rest] = checkInHead(message.checkIn).split(' · ');
  return (
    <div
      className="agent-checkin"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <span className="agent-peer__line">
        <RoutineIcon size={12} />
        {label}
        {rest.length > 0 && <span className="agent-checkin__late">· {rest.join(' · ')}</span>}
      </span>
      <span className="agent-checkin__note">{message.text}</span>
    </div>
  );
});

/**
 * Something Ship Studio did for the agent, said quietly so it never happens
 * invisibly: "npm test · always allowed".
 */
/**
 * A take-over's terminal that closed by itself: the sentence as a Line, and
 * its last screen one click away rather than a terminal dump in the chat.
 */
function TakeoverEndedLine({
  message,
  arrived,
  tail,
}: { message: AgentMessage; tail: [string, string] } & Arrival) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="agent-note agent-note--takeover"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      {tail[0].replace(/\s*The last thing it showed:\s*$/, '')}{' '}
      <TextButton tabIndex={0} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide its last screen' : 'Show its last screen'}
      </TextButton>
      {open && <pre className="agent-bubble__screen agent-note__screen">{tail[1]}</pre>}
    </div>
  );
}

export const NoteLine = memo(function NoteLine({
  message,
  arrived,
  onOpenPeer,
  agent,
}: {
  message: AgentMessage;
  onOpenPeer?: (agentId: string) => void;
  /** Whose home a timeline's screenshots live in; without it, no timeline. */
  agent?: Agent;
} & Arrival) {
  // Where a new conversation began: a divider, since what's above it is history to the agent.
  if (message.fresh) {
    return (
      <div
        className="agent-fresh"
        role="separator"
        aria-label={message.text}
        data-arrived={arrived || undefined}
        data-message-ids={message.id}
      >
        {message.text}
      </div>
    );
  }
  // A take-over's terminal that closed by itself: quiet, as any note, with
  // what it last showed. The agent didn't fail, so nothing offers a Retry.
  const tail = screenTail(message);
  if (tail) return <TakeoverEndedLine message={message} arrived={arrived} tail={tail} />;
  if (message.remembered) return <RememberedLine message={message} arrived={arrived} />;
  if (message.fix) return <NoteFixLine message={message} arrived={arrived} />;
  // "Created Finance": the agent it names is a link, while that agent exists.
  const name = message.peer?.name;
  const at = name && onOpenPeer ? message.text.indexOf(name) : -1;
  const note = (
    <div className="agent-note" data-arrived={arrived || undefined} data-message-ids={message.id}>
      {at < 0 || !message.peer ? (
        message.text
      ) : (
        <>
          {message.text.slice(0, at)}
          {/* Not a Tab stop: an audit trail of links is a long walk to the
              composer, and every agent is in the sidebar. */}
          <TextButton
            tabIndex={-1}
            className="agent-note__link"
            onClick={() => onOpenPeer?.(message.peer!.id)}
          >
            {name}
          </TextButton>
          {message.text.slice(at + name!.length)}
        </>
      )}
    </div>
  );
  if (!message.work || !agent) return note;
  return (
    <>
      {note}
      <div className="agent-chat__row agent-chat__row--agent" data-work>
        <WorkTimeline
          work={message.work}
          agent={agent}
          messageId={message.id}
          ownerId={message.agentId}
        />
      </div>
    </>
  );
});

/**
 * "Remembered: Lead Gen can always … · Undo": a rule the agent recorded from
 * what you said in chat (`remember_permission`). Undo takes it back (on the
 * phone too); the line then reads "Undone".
 */
function RememberedLine({ message, arrived }: { message: AgentMessage } & Arrival) {
  const { showToast } = useOptionalToast();
  const rule = message.remembered!;
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      await revokePermission(message.agentId, rule.ruleId);
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="agent-note"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
      data-remembered={rule.active ? 'active' : 'undone'}
    >
      {message.text} ·{' '}
      {rule.active ? (
        <TextButton className="agent-note__link" disabled={busy} onClick={() => void undo()}>
          Undo
        </TextButton>
      ) : (
        'Undone'
      )}
    </div>
  );
}

/**
 * Links in the other assistant's words: web links open in the system
 * browser, never in the app's own webview; anything else (a local path, a
 * custom scheme) is inert. Unlike the agents' own prose, nothing here is
 * trusted to open a file on this Mac.
 */
function onConnectorLinkClick(event: MouseEvent<HTMLElement>) {
  const anchor = (event.target as HTMLElement).closest('a');
  const href = anchor?.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  if (/^https?:/i.test(href)) void openUrl(href);
}

/**
 * One line of an import conversation (`agents/connector.rs`). The other
 * assistant's words sit on the left, outlined and labelled "From Grok · via
 * connector"; what the sealed interview wrote back to it is indented under
 * them as "To Grok", so neither reads as the Chief talking to you, or as you.
 */
export const ConnectorBubble = memo(function ConnectorBubble({
  message,
  arrived,
}: { message: AgentMessage } & Arrival) {
  const onKeyDown = useCopyOnKey(message.text);
  const source = message.peer?.name ?? 'another assistant';
  const outgoing = message.kind === 'sent_to_agent';
  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`agent-chat__row agent-chat__row--connector${outgoing ? ' agent-chat__row--to-connector' : ''}`}
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <span className="agent-connector__who">
        {outgoing ? (
          <>
            To {source}
            <span className="agent-connector__via"> · from the import conversation</span>
          </>
        ) : (
          <>From {source}</>
        )}
      </span>
      {/* Plain text: never HTML or markdown, whatever the other assistant sent. */}
      <div
        className={`agent-bubble agent-bubble--connector${outgoing ? ' agent-bubble--to-connector' : ''}`}
        onClick={onConnectorLinkClick}
        data-plain
      >
        {connectorTextParts(message.text).map((part, i) =>
          'url' in part ? (
            <a key={i} href={part.url} className="agent-connector__link">
              {part.url}
            </a>
          ) : (
            part.text
          )
        )}
      </div>
    </div>
  );
});

export const DayDivider = memo(function DayDivider({ ts, arrived }: { ts: number } & Arrival) {
  return (
    <div className="agent-chat__divider" data-arrived={arrived || undefined}>
      {formatDivider(ts)}
    </div>
  );
});

interface PeerGroupProps extends Arrival {
  peer: AgentRef;
  messages: AgentMessage[];
  onOpenPeer: (agentId: string) => void;
  /** A search jumped to a line inside: open the thread to show it. */
  reveal?: boolean;
  /** The newest line with this peer: show the peer's live state beside its name. */
  live?: boolean;
  /** The brief this agent is working on right now: open until the turn ends. */
  driving?: boolean;
}

/**
 * "Messaged Finance" / "Message from Chief of Staff" / "5 messages with
 * Finance". Collapsed by default: the conversation between agents is there
 * when you want it and out of the way when you don't.
 */
export const PeerGroup = memo(function PeerGroup({
  peer,
  messages,
  onOpenPeer,
  arrived,
  reveal,
  live,
  driving,
}: PeerGroupProps) {
  // The peer as it exists now; absent if it was deleted. Read here, not passed
  // down, so the history isn't rebuilt whenever any agent changes. Only the
  // newest line shows the peer's live state; the others need only to know it's there.
  const peerAgent = useAgentsSelector(
    (s) => agentIn(s.agents, peer.id),
    live ? Object.is : (a, b) => Boolean(a) === Boolean(b)
  );
  // Links in the thread open like a reply's, never inside the app webview.
  const onProseClick = useProseLinks(peer.id);
  // Until the user toggles it, it follows whether it's the brief in progress.
  const [chosen, setChosen] = useState<boolean | null>(reveal ? true : null);
  const [revealed, setRevealed] = useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal) setChosen(true);
  }
  const open = chosen ?? Boolean(driving);
  const setOpen = (toggle: (v: boolean) => boolean) => setChosen(toggle(open));
  const threadRef = useRef<HTMLDivElement>(null);
  const threadShown = useHeightReveal(threadRef, open);
  // One Tab stop per line: the toggle. ← / → reach the peer's name beside it.
  const onLineKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
    const at = buttons.indexOf(event.target as Element);
    const next = buttons[at + (event.key === 'ArrowRight' ? 1 : -1)] as HTMLElement | undefined;
    if (at < 0 || !next) return;
    event.preventDefault();
    next.focus();
  };
  return (
    <div
      className="agent-peer"
      data-arrived={arrived || undefined}
      data-message-ids={messages.map((m) => m.id).join(' ')}
    >
      <div className="agent-peer__line" onKeyDown={onLineKeyDown}>
        <button
          type="button"
          tabIndex={0}
          className="agent-peer__toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon size={10} className="agent-peer__chevron" />
          {peerGroupLabel(messages)}
        </button>
        <Tooltip content={peerAgent ? `Open ${peer.name}` : `${peer.name} was deleted`}>
          <button
            type="button"
            tabIndex={-1}
            className="agent-peer__name"
            onClick={() => peerAgent && onOpenPeer(peerAgent.id)}
            disabled={!peerAgent}
          >
            {peer.name}
            {live && peerAgent && <AgentPeerStatus agent={peerAgent} />}
          </button>
        </Tooltip>
      </div>
      {threadShown && (
        <div ref={threadRef} className="agent-peer__thread" onClick={onProseClick}>
          {messages.map((m) => (
            <div key={m.id} className="agent-peer__message" data-direction={m.kind}>
              {/* One message: the line above already says who it's from or to. */}
              {messages.length > 1 && (
                <span className="agent-peer__who">
                  {m.kind === 'sent_to_agent' ? `To ${peer.name}` : peer.name}
                </span>
              )}
              <div className="agent-peer__text agent-markdown">
                <Prose text={m.text} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** A request the app closed for the user (`Approval.setAside`); the why is its note. */
export const SET_ASIDE_OUTCOME = 'Set aside · nothing ran';

const STATUS_LABEL = {
  allowed: 'Allowed',
  denied: 'Declined',
  expired: 'Not answered in time',
} as const;

interface ApprovalCardProps extends Arrival {
  message: AgentMessage;
  /** Whose card this is, for what "Always allow" says it covers. */
  agentName: string;
  /** The agent stopped waiting (its turn ended). Allowing wakes it to finish. */
  paused: boolean;
  onAnswer: (
    requestId: string,
    allow: boolean,
    always?: boolean,
    note?: string,
    /** On a session's question: the index of the option picked. */
    choice?: number
  ) => Promise<void | boolean>;
  /**
   * Team's compact form: field values clamp to two lines with "Show all",
   * and the outcome says what happens next.
   */
  compact?: boolean;
  /**
   * Its place in a run of the same request from the same agent ("1 of 3
   * similar requests"): counted from the cards that have arrived, never
   * from how many the agent might still send.
   */
  series?: { index: number; total: number };
}

/** "subject" → "Subject", "cc_list" → "Cc list". */
const fieldLabel = (key: string) => {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/**
 * The exact thing being approved, readable. A connector tool's input (an
 * email to send, a record to write) is shown as labelled fields rather than
 * raw JSON; Claude Code's own tools already come with a one-line detail.
 * Every value is shown in full: this is what the user is agreeing to.
 */
function approvalFields(tool: string | undefined, input: unknown): [string, string][] | null {
  if (!tool?.startsWith('mcp__') || !input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const fields = Object.entries(input as Record<string, unknown>).map(
    ([key, value]): [string, string] => [
      fieldLabel(key),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    ]
  );
  return fields.length ? fields : null;
}

/** What the card resolved to; Team says what happens next, since the chat isn't in view. */
function outcomeText(approval: Approval, agentName: string, compact: boolean): ReactNode {
  if (approval.alwaysAllowed && approval.always) {
    return (
      <>
        {approval.always.said ? 'Allowed by your rule' : 'Always allowed'} ·{' '}
        {approval.always.kind.startsWith('command') ? (
          <code>{approval.always.label}</code>
        ) : (
          approval.always.label
        )}
      </>
    );
  }
  if (approval.front && (approval.status === 'allowed' || approval.status === 'denied')) {
    return approval.status === 'allowed' ? 'Checked again' : 'Not now';
  }
  if (approval.status === 'denied' && approval.note) {
    return <>Declined · “{approval.note}”</>;
  }
  if (approval.status === 'expired' && approval.setAside) {
    return approval.settings ? `Not changed · ${approval.setAside}` : SET_ASIDE_OUTCOME;
  }
  if (approval.settings && approval.status === 'allowed') {
    return 'Changed · from each agent’s next message';
  }
  if (approval.plan && approval.status === 'allowed') {
    return 'Allowed · each step runs without asking for an hour';
  }
  if (approval.handoff && approval.status === 'allowed') {
    return `Saving to memory · ${agentName} is keeping it and briefing your agents`;
  }
  if (approval.handoff && approval.status === 'denied') {
    return 'Ignored · nothing was saved';
  }
  if (approval.skill) {
    const said = skillOutcome(approval.status);
    if (said) return said;
  }
  if (approval.gate && approval.status === 'allowed') {
    return `Going ahead · step ${approval.gate.done + 1} of ${approval.gate.total} is running`;
  }
  if (approval.gate && approval.status === 'denied') {
    return `Stopped after step ${approval.gate.done} · the rest didn’t run`;
  }
  if (approval.choice && approval.status !== 'expired') {
    return `${STATUS_LABEL[approval.status as 'allowed' | 'denied']} · ${approval.choice}`;
  }
  const from = answeredWords(approval.status, approval.answeredFrom);
  if (from) return from;
  const label = STATUS_LABEL[approval.status as keyof typeof STATUS_LABEL];
  if (compact && approval.status === 'allowed') return `${label} · ${agentName} is carrying on`;
  return label;
}

/**
 * A request card in its own boundary: one that fails to draw still offers
 * Deny (`AgentApprovalFallback`), so the turn waiting on it isn't stuck.
 */
export const ApprovalCard = memo(function GuardedApprovalCard(props: ApprovalCardProps) {
  return (
    <AreaBoundary
      where="approval-card"
      fallback={() => <ApprovalFallback message={props.message} onAnswer={props.onAnswer} />}
    >
      <ApprovalCardBody {...props} />
    </AreaBoundary>
  );
});

/** "A" / "D" inside an answer button, shown only while its card has focus. */
function KeyHint({ letter }: { letter: string }) {
  return (
    <kbd className="agent-approval__key" aria-hidden>
      {letter}
    </kbd>
  );
}

const ApprovalCardBody = memo(function ApprovalCard({
  message,
  agentName,
  paused,
  onAnswer,
  arrived,
  compact = false,
  series,
}: ApprovalCardProps) {
  const approval = message.approval;
  const [busy, setBusy] = useState(false);
  // Deny denies. "Deny with a note…" (the card's … menu) opens one line for
  // what to do instead; sent empty, it's a plain deny.
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const denyRef = useRef<HTMLButtonElement>(null);
  const refocusDeny = useRef(false);
  useEffect(() => {
    if (noting || !refocusDeny.current) return;
    refocusDeny.current = false;
    denyRef.current?.focus();
  }, [noting]);
  const cancelNote = () => {
    refocusDeny.current = true;
    setNoting(false);
  };
  const [showAll, setShowAll] = useState(!compact);
  // A card with a plain summary (a push) keeps its raw lines behind Details.
  const [details, setDetails] = useState(false);
  // Answered while on screen, so the buttons resolve into the outcome;
  // a card that loads already answered just shows it.
  const [openedPending] = useState(approval?.status === 'pending');
  const { armed, guard, keyProps } = useCardGuard(approval?.status === 'pending');
  if (!approval) return null;
  // Nobody answered: a quiet one-line receipt, not a card still asking.
  const expired = approval.status === 'expired' ? expiryLine(approval) : null;
  if (expired) {
    return (
      <div
        className="agent-note agent-note--expired"
        data-arrived={arrived || undefined}
        data-message-ids={message.id}
      >
        {expired}
      </div>
    );
  }
  // A retired "needs you in its browser" card (Step in is gone): one quiet line.
  if (approval.stepIn) {
    return (
      <div
        className="agent-note agent-note--expired"
        data-arrived={arrived || undefined}
        data-message-ids={message.id}
      >
        {STEP_IN_RETIRED_LINE}
      </div>
    );
  }
  // "Carry on with Codex until then?": Wait, Just this time, Always.
  if (approval.crossover) {
    return (
      <CrossoverCard
        message={message}
        onAnswer={(id, allow, always) => onAnswer(id, allow, always)}
        arrived={arrived}
      />
    );
  }
  if (approval.prompt) {
    return (
      <SessionPromptCard
        message={message}
        approval={approval}
        prompt={approval.prompt}
        agentName={agentName}
        onAnswer={onAnswer}
        arrived={arrived}
        compact={compact}
      />
    );
  }
  if (approval.login) {
    return <LoginCard message={message} agentName={agentName} arrived={arrived} />;
  }
  // One message to send as you, with its exact words: a draft to edit, discard or send.
  if (draftOf(approval)) {
    return (
      <AgentDraftCard
        message={message}
        agentName={agentName}
        onAnswer={onAnswer}
        arrived={arrived}
      />
    );
  }
  if (approval.secret) {
    return (
      <SecretCard message={message} agentName={agentName} onAnswer={onAnswer} arrived={arrived} />
    );
  }
  if (approval.connector?.kind === 'playback') {
    return <ImportPlaybackCard message={message} card={approval.connector} arrived={arrived} />;
  }
  if (approval.connector?.kind === 'review') {
    return (
      <ImportReviewCard
        message={message}
        card={approval.connector}
        chiefName={agentName}
        arrived={arrived}
        onAnswer={(id, allow) => onAnswer(id, allow)}
      />
    );
  }
  // Another assistant asking to start an import: a plain yes or no, so Deny
  // doesn't open the "what instead" line.
  // "Bring your Chrome window to the front": Check again / Not now, nothing else.
  const front = !!approval.front;
  // "<source> sent what it knows": Ignore / Save to memory, nothing else.
  const handoff = !!approval.handoff;
  // "OK to go on?" between a routine's steps: Stop here / Go ahead, nothing broader.
  const gate = approval.gate;
  // "Save “…” as a skill?": Not now / Save, nothing broader.
  const skill = approval.skill;
  const plainDeny = approval.connector?.kind === 'consent' || front || handoff || !!gate || !!skill;
  // A plan is read field by field; one with no readable action has nothing
  // to allow, so it offers Deny only.
  const plan = approval.plan ? readPlan(approval.plan) : null;
  const nothingToAllow = !!plan && plan.actions.length === 0;
  // The Mac says this can't be always allowed: its sentence stands where the item was.
  const noAlways = cantAlwaysAllow(approval);
  const pending = approval.status === 'pending';
  const fields = approvalFields(approval.tool, approval.input);
  // A command the app can name says what happens in the title; its raw text is
  // one click away behind Details.
  const { title: shownTitle, plain: plainCommand } = plainApprovalTitle(approval);
  const rawCommand =
    typeof (approval.input as { command?: unknown } | undefined)?.command === 'string'
      ? (approval.input as { command: string }).command
      : approval.detail;
  // One answer for a whole plan, said so: "Allow all 3".
  const planCount = plan?.actions.length ?? 0;
  const scope = plan && pending ? planScope(plan.actions.map((a) => a.kind)) : null;
  const answer = async (allow: boolean, always = false, why?: string) => {
    setBusy(true);
    try {
      await onAnswer(approval.requestId, allow, always, why);
    } finally {
      setBusy(false);
    }
  };
  const long = compact && fields?.some(([, v]) => v.length > 120 || v.includes('\n'));
  // A and D while this card has focus, never anywhere else (`approvalKeys`).
  // Not on a skill offer: nothing waits on it, so it doesn't claim the keys.
  const keys = pending && !noting && !compact && !skill;
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const which = approvalKey(event);
    if (!which) return;
    // The card's key even when it can't act yet (busy, not armed): left to
    // bubble, A or D also opened the agent whose key that letter is.
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    if (which === 'allow' && (nothingToAllow || !armed)) return;
    void answer(which === 'allow');
  };
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
      data-keys={keys || undefined}
      tabIndex={keys ? -1 : undefined}
      onKeyDown={keys ? onCardKey : undefined}
    >
      <AgentCard
        className="agent-approval"
        data={{
          status: approval.status,
          clamped: (long && !showAll) || undefined,
          risk: approval.risk,
          // An offer, not a gate: drawn quieter (agents-skills.css).
          offer: (pending && !!skill) || undefined,
        }}
        // The Mac marked Allow risky (Bold's floor): told apart by the icon as well as hue.
        tone={approval.risk === 'high' ? 'warning' : undefined}
        icon={
          approval.risk === 'high' ? (
            <WarningIcon size={14} />
          ) : front ? (
            <GlobeIcon size={14} />
          ) : handoff ? (
            <DownloadIcon size={14} />
          ) : gate ? (
            <RoutineIcon size={14} />
          ) : skill ? (
            <GraduationCapIcon size={14} />
          ) : plainDeny ? (
            <DownloadIcon size={14} />
          ) : approval.settings ? (
            <SettingsSlidersIcon size={14} />
          ) : (
            <ShieldCheckIcon size={14} />
          )
        }
        title={shownTitle}
        meta={
          gate
            ? `${gate.routine} · step ${gate.done} of ${gate.total} done`
            : series && series.total > 1
              ? `${series.index} of ${series.total} similar requests`
              : undefined
        }
        note={
          pending && approval.always && approval.alwaysNote
            ? approval.alwaysNote
            : pending && gate
              ? 'It waits for you, and closes if the routine runs again first.'
              : pending && skill
                ? SKILL_OFFER_NOTE
                : pending && paused && !plainDeny && !approval.settings && !approval.slackReply
                  ? 'It paused here for you. Allow it and it picks up where it left off.'
                  : approval.status === 'expired'
                    ? approval.setAside
                    : undefined
        }
        actions={
          pending && !noting ? (
            <>
              {approval.always && !nothingToAllow && !noAlways && (
                <Tooltip content={describeScope(approval.always, agentName)}>
                  <TextButton
                    tabIndex={0}
                    className="agent-approval__always"
                    disabled={busy}
                    {...keyProps}
                    onClick={guard(() => void answer(true, true))}
                  >
                    Always allow{' '}
                    {approval.always.kind.startsWith('command') ? (
                      <code>{approval.always.label}</code>
                    ) : (
                      approval.always.label
                    )}
                  </TextButton>
                </Tooltip>
              )}
              {/* A note for what to do instead is the rarer answer: one menu away, as on
                  the phone. A consent card has nothing to say instead: just Deny. */}
              {!plainDeny && (
                <Dropdown
                  align="right"
                  portal
                  className="agent-approval__more"
                  trigger={(p) => (
                    <IconButton
                      {...p}
                      tabIndex={0}
                      variant="ghost"
                      size="compact"
                      disabled={busy}
                      icon={<MoreHorizontalIcon size={14} />}
                      aria-label="More answers"
                      title="More answers"
                    />
                  )}
                >
                  <DropdownItem onSelect={() => setNoting(true)}>Deny with a note…</DropdownItem>
                </Dropdown>
              )}
              {/* tabIndex: WebKit leaves buttons out of the Tab order unless asked. */}
              <Button
                ref={denyRef}
                tabIndex={0}
                variant={skill ? 'ghost' : 'secondary'}
                className="agent-approval__deny"
                disabled={busy}
                data-deny
                onClick={() => void answer(false)}
                aria-keyshortcuts={keys ? 'D Meta+Backspace' : undefined}
              >
                {front
                  ? 'Not now'
                  : handoff
                    ? 'Ignore'
                    : gate
                      ? GATE_DENY
                      : skill
                        ? SKILL_NOT_NOW
                        : 'Deny'}
                {keys && <KeyHint letter="D" />}
              </Button>
              {!nothingToAllow && (
                <Button
                  tabIndex={0}
                  // An offer's yes is a choice, not a release: outlined, not solid.
                  variant={skill ? 'secondary' : 'strong'}
                  data-allow
                  disabled={busy}
                  {...keyProps}
                  onClick={guard(() => void answer(true))}
                  aria-keyshortcuts={keys ? 'A Meta+Enter' : undefined}
                >
                  {front
                    ? 'Check again'
                    : handoff
                      ? 'Save to memory'
                      : gate
                        ? GATE_ALLOW
                        : skill
                          ? SKILL_SAVE
                          : planCount > 1
                            ? `Allow all ${planCount}`
                            : 'Allow'}
                  {keys && <KeyHint letter="A" />}
                </Button>
              )}
            </>
          ) : undefined
        }
        outcome={pending ? undefined : outcomeText(approval, agentName, compact)}
        outcomeTone={approval.status === 'allowed' ? 'done' : undefined}
        resolved={openedPending && !pending}
      >
        {approval.settings ? (
          <AgentSettingsChange proposal={approval.settings} />
        ) : skill ? (
          <AgentSkillCardBody card={skill} />
        ) : gate ? (
          <AgentGateBody gate={gate} produced={approval.detail} />
        ) : plan ? (
          <AgentPlanList plan={plan} />
        ) : plainCommand ? (
          <>
            {approval.summary && (
              <p className="agent-approval__detail agent-approval__detail--prose">
                {approval.summary}
              </p>
            )}
            <TextButton
              tabIndex={0}
              className="agent-approval__show-all"
              aria-expanded={details}
              onClick={() => setDetails((v) => !v)}
            >
              {details ? 'Hide details' : 'Details'}
            </TextButton>
            {details && <pre className="agent-approval__detail">{rawCommand}</pre>}
          </>
        ) : fields ? (
          <dl className="agent-approval__fields">
            {fields.map(([label, value]) => (
              <div key={label} className="agent-approval__field">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : approval.summary ? (
          <>
            <p className="agent-approval__detail agent-approval__detail--prose">
              {approval.summary}
            </p>
            {approval.detail && (
              <TextButton
                tabIndex={0}
                className="agent-approval__show-all"
                aria-expanded={details}
                onClick={() => setDetails((v) => !v)}
              >
                {details ? 'Hide details' : handoff ? 'Review' : 'Details'}
              </TextButton>
            )}
            {details && <pre className="agent-approval__detail">{approval.detail}</pre>}
          </>
        ) : (
          approval.detail &&
          (plainDeny ? (
            <p className="agent-approval__detail agent-approval__detail--prose">
              {approval.detail}
            </p>
          ) : (
            <pre className="agent-approval__detail">{approval.detail}</pre>
          ))
        )}
        {/* Why this one is asked, as the Mac worked it out (never worked out here). */}
        {pending && approval.riskNote && (
          <p className="agent-card__note agent-approval__risk">{approval.riskNote}</p>
        )}
        {/* What the one OK covers, on a card that goes outward. */}
        {scope && <p className="agent-card__note agent-approval__scope">{scope}</p>}
        {long && (
          <TextButton
            tabIndex={0}
            className="agent-approval__show-all"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show less' : 'Show all'}
          </TextButton>
        )}
        {pending && noting && (
          <form
            className="agent-approval__deny-note"
            onSubmit={(e) => {
              e.preventDefault();
              void answer(false, false, note.trim() || undefined);
            }}
          >
            <TextField
              autoFocus
              value={note}
              maxLength={500}
              disabled={busy}
              placeholder={`What should ${agentName} do instead? (optional)`}
              aria-label={`What ${agentName} should do instead (optional)`}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                e.stopPropagation();
                cancelNote();
              }}
            />
            <Button tabIndex={0} variant="ghost" disabled={busy} onClick={cancelNote}>
              Cancel
            </Button>
            <Button tabIndex={0} type="submit" variant="secondary" disabled={busy}>
              Deny
            </Button>
          </form>
        )}
      </AgentCard>
    </div>
  );
});

interface SessionPromptCardProps extends Arrival {
  message: AgentMessage;
  approval: Approval;
  prompt: SessionPrompt;
  agentName: string;
  onAnswer: ApprovalCardProps['onAnswer'];
  compact: boolean;
}

/** An edit as decisions.rs `plain_detail` says it: "Edit index.html", "Create a.md". */
const EDIT_SENTENCE = /^(Edit|Create) [^\n]+$/;

/**
 * A question a project session is waiting on, with the session's own words
 * and options. The same card is in every chat the work touched; answering
 * here sends the option's keys to the session and resolves it everywhere.
 */
function SessionPromptCard({
  message,
  approval,
  prompt,
  agentName,
  onAnswer,
  arrived,
  compact,
}: SessionPromptCardProps) {
  const [busy, setBusy] = useState(false);
  const [openedPending] = useState(approval.status === 'pending');
  const pending = approval.status === 'pending';
  const { guard, keyProps } = useCardGuard(pending);
  const choose = async (allow: boolean, choice?: number) => {
    setBusy(true);
    try {
      await onAnswer(approval.requestId, allow, false, undefined, choice);
    } finally {
      setBusy(false);
    }
  };
  const indexed = prompt.options.map((option, index) => ({ option, index }));
  const allow = indexed.find(({ option }) => option.role === 'allow');
  const deny = indexed.find(({ option }) => option.role === 'deny');
  const others = indexed.filter(({ option }) => option.role === 'other');
  return (
    <div
      className="agent-chat__row agent-chat__row--agent agent-chat__row--card"
      data-arrived={arrived || undefined}
      data-message-ids={message.id}
    >
      <AgentCard
        className="agent-approval"
        data={{ status: approval.status, prompt: prompt.kind }}
        icon={
          prompt.kind === 'trust' ? (
            <FolderIcon size={14} />
          ) : prompt.kind === 'permission' ? (
            <ShieldCheckIcon size={14} />
          ) : (
            <CommentIcon size={14} />
          )
        }
        title={approval.title}
        source={`${prompt.owner.name} · in ${folderName(prompt.project)}`}
        wrapActions={others.length > 0}
        actions={
          pending ? (
            <>
              {others.map(({ option, index }) => (
                <Button
                  key={index}
                  tabIndex={0}
                  variant="secondary"
                  size={compact ? 'compact' : undefined}
                  className="agent-approval__choice"
                  disabled={busy}
                  {...keyProps}
                  onClick={guard(() => void choose(true, index))}
                >
                  {option.label}
                </Button>
              ))}
              {deny && (
                <Tooltip content={deny.option.label}>
                  <Button
                    tabIndex={0}
                    variant="secondary"
                    className="agent-approval__deny"
                    disabled={busy}
                    onClick={() => void choose(false, deny.index)}
                  >
                    Deny
                  </Button>
                </Tooltip>
              )}
              {allow && (
                <Tooltip content={allow.option.label}>
                  <Button
                    tabIndex={0}
                    variant="strong"
                    data-allow
                    disabled={busy}
                    {...keyProps}
                    onClick={guard(() => void choose(true, allow.index))}
                  >
                    Allow
                  </Button>
                </Tooltip>
              )}
            </>
          ) : undefined
        }
        outcome={pending ? undefined : outcomeText(approval, agentName, false)}
        outcomeTone={approval.status === 'allowed' ? 'done' : undefined}
        resolved={openedPending && !pending}
      >
        {/* Folder trust is our explanation and an edit is one sentence ("Edit
            index.html", decisions.rs `plain_detail`): prose. A command keeps
            its own lines, a one-line command too. */}
        {approval.detail &&
          (prompt.kind === 'trust' || EDIT_SENTENCE.test(approval.detail) ? (
            <p className="agent-card__note">{approval.detail}</p>
          ) : (
            <pre className="agent-approval__detail">{approval.detail}</pre>
          ))}
      </AgentCard>
    </div>
  );
}

/**
 * The chat's gentle nudge once its engine reports the conversation nearly
 * full. Shown only from a real reading, never from a guess, and only while
 * idle: a turn in progress is still using the conversation it would leave,
 * and a take-over is driving it.
 */
export function FreshHint({ agent, onStartFresh }: { agent: Agent; onStartFresh: () => void }) {
  const percent = contextPercent(agent);
  // While you're driving it, Start fresh can't run: don't offer it.
  if (
    percent === null ||
    percent < CONTEXT_SUGGEST_AT ||
    agent.status.state !== 'idle' ||
    agent.takeover
  ) {
    return null;
  }
  return (
    <div className="agent-note agent-fresh-hint">
      This conversation is getting long — {agent.name} may lose track of early details.{' '}
      <TextButton
        tabIndex={0}
        variant="primary"
        className="agent-fresh-hint__action"
        onClick={onStartFresh}
      >
        Start a new conversation (memory is kept)
      </TextButton>
    </div>
  );
}
