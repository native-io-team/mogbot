/**
 * The three surfaces a conversation is built from, besides its messages.
 * Everything that isn't something someone said is one of these, so a chat
 * with a request, a copy waiting to be kept and an import going on at once
 * still reads as one product (docs/agents.md, "Lines, cards and bars").
 *
 * - **Line** (`AgentLine`): one quiet centred sentence, no surface, that
 *   wraps. Something that happened, with at most one text action.
 * - **Card** (`AgentCard`): something that wants a decision or holds a
 *   result. Icon and title, a muted source line, the body, a muted note, then
 *   the actions right-aligned with the single affirmative last. Answered, it
 *   becomes its outcome line (title · outcome, "Show request" for the rest).
 * - **Bar** (`ConversationBar`, stacked by `ConversationBars`): the state of
 *   this conversation until it ends — you're driving it, an import is going.
 *   The reading column's width, directly above the composer, in a fixed
 *   order, at most two at a time.
 *
 * The rules the actions follow:
 * - The affirmative answer on a request or decision (Allow, Save, Keep
 *   changes, Import) is `variant="strong"`: neutral, never the accent. An
 *   agent's colour can be red, and Allow must never look like the dangerous
 *   choice. `approvalNeutral.test.tsx` holds it.
 * - `danger` is only for what destroys the user's work (Discard, Delete).
 *   Stopping an import, taking over or quitting lose nothing: `secondary`.
 * - Secondary is `secondary`, rarer is a `TextButton`, rarest a ⋯ menu.
 *
 * @module components/agents/AgentCard
 */

import {
  Children,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type FormEventHandler,
  type ReactNode,
} from 'react';
import { TextButton } from '../primitives/TextButton';

interface AgentCardProps {
  /** A form card submits with Enter (the secret card). */
  as?: 'div' | 'form' | 'section' | 'article';
  onSubmit?: FormEventHandler<HTMLFormElement>;
  className?: string;
  /** Semantic, 14px: who or what is asking. Not a warning sign by default. */
  icon?: ReactNode;
  /** Only for a genuinely risky request: the icon takes the warning colour. */
  tone?: 'warning';
  title: ReactNode;
  /** Quiet, right of the title ("1 of 3 similar requests"). */
  meta?: ReactNode;
  /** Muted line under the title: whose, and where ("Acme Site · in demo-site"). */
  source?: ReactNode;
  /** Muted consequence line, before the actions. */
  note?: ReactNode;
  /** Right-aligned; the caller puts the single affirmative last. */
  actions?: ReactNode;
  /** Shown in place of the actions once it's answered. */
  outcome?: ReactNode;
  /** The outcome appeared while on screen: it eases in. */
  resolved?: boolean;
  /** The outcome's tone: an allowed answer reads as done. */
  outcomeTone?: 'done';
  /** Lets the actions wrap (a session's extra choices). */
  wrapActions?: boolean;
  children?: ReactNode;
  'aria-label'?: string;
  'data-testid'?: string;
  /** Free data attributes for styling and the harness (`data-status`, …). */
  data?: Record<string, string | boolean | undefined>;
}

export function AgentCard({
  as = 'div',
  onSubmit,
  className,
  icon,
  tone,
  title,
  meta,
  source,
  note,
  actions,
  outcome,
  resolved,
  outcomeTone,
  wrapActions,
  children,
  data,
  ...aria
}: AgentCardProps) {
  const [showRequest, setShowRequest] = useState(false);
  // Answered, a card becomes its outcome line: the title and what was
  // decided, with the request one click away. One answered while on screen
  // (`resolved`) stays whole, so the answer eases in where it was given.
  const answered = !!outcome && !resolved && !hasContent(actions);
  const dataAttrs = Object.fromEntries(
    Object.entries({
      ...data,
      answered: answered || undefined,
      open: (answered && showRequest) || undefined,
    }).map(([k, v]) => [`data-${k}`, v === true ? '' : v || undefined])
  );
  const request = hasContent(children) || !!source || !!note;
  const body = answered ? (
    <>
      <div className="agent-card__answered">
        <span className="agent-card__answered-title">{title}</span>
        <span className="agent-card__outcome agent-card__outcome--inline" data-tone={outcomeTone}>
          {outcome}
        </span>
        {request && (
          <TextButton
            tabIndex={0}
            className="agent-card__show-request"
            aria-expanded={showRequest}
            onClick={() => setShowRequest((v) => !v)}
          >
            {showRequest ? 'Hide request' : 'Show request'}
          </TextButton>
        )}
      </div>
      {showRequest && (
        <div className="agent-card__request">
          {source && <p className="agent-card__source">{source}</p>}
          {children}
          {note && <p className="agent-card__note">{note}</p>}
        </div>
      )}
    </>
  ) : (
    <>
      <div className="agent-card__title">
        {icon && (
          <span className="agent-card__icon" data-tone={tone} aria-hidden>
            {icon}
          </span>
        )}
        <span className="agent-card__title-text">{title}</span>
        {meta && <span className="agent-card__meta">{meta}</span>}
      </div>
      {source && <p className="agent-card__source">{source}</p>}
      {children}
      {note && <p className="agent-card__note">{note}</p>}
      {actions && hasContent(actions) && (
        <div className="agent-card__actions" data-wrap={wrapActions || undefined}>
          {actions}
        </div>
      )}
      {outcome && (
        <div
          className="agent-card__outcome"
          data-resolved={resolved || undefined}
          data-tone={outcomeTone}
        >
          {outcome}
        </div>
      )}
    </>
  );
  const cls = className ? `agent-card ${className}` : 'agent-card';
  if (as === 'form') {
    return (
      <form className={cls} onSubmit={onSubmit} {...dataAttrs} {...aria}>
        {body}
      </form>
    );
  }
  if (as === 'section') {
    return (
      <section className={cls} {...dataAttrs} {...aria}>
        {body}
      </section>
    );
  }
  if (as === 'article') {
    return (
      <article className={cls} {...dataAttrs} {...aria}>
        {body}
      </article>
    );
  }
  return (
    <div className={cls} {...dataAttrs} {...aria}>
      {body}
    </div>
  );
}

const hasContent = (node: ReactNode) => Children.toArray(node).length > 0;

/**
 * One quiet centred sentence in the conversation: it wraps rather than cut
 * its second half (which is usually the reassuring part).
 */
export function AgentLine({
  children,
  className,
  role,
  'data-testid': testId,
}: {
  children: ReactNode;
  className?: string;
  role?: 'status';
  'data-testid'?: string;
}) {
  return (
    <div
      className={className ? `agent-note ${className}` : 'agent-note'}
      role={role}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export interface BarSpec {
  /** Its place in the fixed order. */
  id: BarId;
  /** A bar component; it may render nothing (no import going), and then takes no room. */
  node: ReactNode;
}

/** The fixed order bars stack in, top to bottom. */
export const BAR_ORDER = [
  'takeover',
  'import',
  'setup',
  'requests',
  'engine',
  'secret',
  'dictation',
] as const;
export type BarId = (typeof BAR_ORDER)[number];

/** How many bars show before the rest fold into "N more". */
export const MAX_BARS = 2;

/**
 * Bars that never fold: a key in the draft guards something the user is
 * about to do and can't take back, so it shows whatever else is up, and
 * takes its place in the two first.
 */
export const PINNED_BARS: readonly BarId[] = ['secret'];

/**
 * The bars above the composer, in their fixed order. Past two, the rest fold
 * into one "N more" that opens them; the composer is never pushed off the
 * screen by its own notices. A pinned bar (`PINNED_BARS`) is always shown.
 * Each bar decides for itself whether it shows (from its own store), so
 * what's on screen is counted from the slots.
 */
export function ConversationBars({ bars }: { bars: BarSpec[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [folded, setFolded] = useState(0);
  const sorted = [...bars].sort((a, b) => BAR_ORDER.indexOf(a.id) - BAR_ORDER.indexOf(b.id));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const slots = Array.from(el.children).filter(
        (slot): slot is HTMLElement =>
          slot instanceof HTMLElement && slot.classList.contains('agent-bars__slot')
      );
      const pinned = (slot: HTMLElement) =>
        (PINNED_BARS as readonly string[]).includes(slot.dataset.bar ?? '');
      // Pinned bars spend the budget first, so the rest fold around them.
      let shown = slots.filter((slot) => pinned(slot) && slot.childElementCount > 0).length;
      let over = 0;
      for (const slot of slots) {
        const filled = slot.childElementCount > 0;
        if (pinned(slot)) {
          slot.hidden = !filled;
          continue;
        }
        const hide = !filled || (shown >= MAX_BARS && !expanded);
        if (filled && hide) over++;
        else if (filled) shown++;
        slot.hidden = hide;
      }
      el.toggleAttribute('data-empty', shown === 0);
      setFolded(over);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <div className="agent-bars" ref={ref} data-testid="agent-bars">
      {sorted.map((b) => (
        <div key={b.id} className="agent-bars__slot" data-bar={b.id}>
          {b.node}
        </div>
      ))}
      {folded > 0 && (
        <TextButton tabIndex={0} className="agent-bars__more" onClick={() => setExpanded(true)}>
          {folded} more
        </TextButton>
      )}
    </div>
  );
}

/**
 * One bar: a dot or icon in the state's colour, the title and a detail on
 * one line (the detail wraps underneath when it must), and its actions.
 */
export function ConversationBar({
  state = 'info',
  icon,
  title,
  detail,
  actions,
  children,
  role = 'status',
  'data-testid': testId,
  dataState,
}: {
  /** amber = waiting on you, accent = going on, muted = information. */
  state?: 'waiting' | 'active' | 'info';
  /** In place of the dot (a lock for the secret hint). */
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  /** Under the row (what Claude Code will ask first, when you take over). */
  children?: ReactNode;
  role?: 'status' | 'alert';
  'data-testid'?: string;
  dataState?: string;
}) {
  return (
    <div
      className="agent-bar"
      data-tone={state}
      data-state={dataState}
      role={role}
      data-testid={testId}
    >
      <div className="agent-bar__row">
        {icon ? (
          <span className="agent-bar__icon" aria-hidden>
            {icon}
          </span>
        ) : (
          <span className="agent-bar__dot" aria-hidden />
        )}
        <span className="agent-bar__text">
          <span className="agent-bar__title">{title}</span>
          {detail && <span className="agent-bar__detail">{detail}</span>}
        </span>
        {actions && isValidNode(actions) && <span className="agent-bar__actions">{actions}</span>}
      </div>
      {children}
    </div>
  );
}

const isValidNode = (node: ReactNode) =>
  Children.toArray(node).some((c) => isValidElement(c) || (typeof c === 'string' && c !== ''));
