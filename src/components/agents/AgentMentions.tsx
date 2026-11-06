/**
 * @mentions: typing @ in the composer offers your other agents; picking one
 * writes "@Name" into the message. Sent to agent A, "@B" asks A to involve B
 * (for the Chief of Staff, to delegate to B). The backend records who was
 * mentioned and adds that line to the prompt; the bubble tints the names.
 *
 * Focus never leaves the text field while the menu is up, so it is a listbox
 * the field drives (↑ ↓, Return or Tab to pick, Esc to dismiss), drawn with
 * the app's menu surface.
 *
 * @module components/agents/AgentMentions
 */

import { useCallback, useState, type KeyboardEvent, type RefObject } from 'react';
import { CollaboratorsIcon } from '@/components/icons';
import { AgentAvatar } from './AgentAvatar';
import { EVERYONE_ID } from '../../lib/agentRooms';
import {
  mentionAt,
  mentionCandidates,
  mentionRuns,
  type Agent,
  type AgentRef,
} from '../../lib/agents';

interface Open {
  start: number;
  query: string;
}

export function useMentionPicker(
  agents: Agent[],
  inputRef: RefObject<HTMLTextAreaElement | null>,
  setDraft: (text: string) => void
) {
  const [open, setOpen] = useState<Open | null>(null);
  const [active, setActive] = useState(0);
  // Esc puts the menu away for this @, until the caret leaves it.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const candidates = open ? mentionCandidates(agents, open.query) : [];
  const showing = open !== null && open.start !== dismissed && candidates.length > 0;

  /** Re-read the @ at the caret; call on every edit and caret move. */
  const sync = useCallback(() => {
    const el = inputRef.current;
    const next =
      el && el.selectionStart === el.selectionEnd ? mentionAt(el.value, el.selectionStart) : null;
    setOpen((current) =>
      current?.start === next?.start && current?.query === next?.query ? current : next
    );
    if (!next) setDismissed(null);
    setActive(0);
  }, [inputRef]);

  const pick = useCallback(
    (agent: Agent) => {
      const el = inputRef.current;
      if (!el || !open) return;
      const caret = el.selectionStart;
      const before = `${el.value.slice(0, open.start)}@${agent.name} `;
      const after = el.value.slice(caret).replace(/^ /, '');
      setDraft(before + after);
      setOpen(null);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(before.length, before.length);
      });
    },
    [inputRef, open, setDraft]
  );

  /** The field's keys while the menu is up; true when the menu took the key. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!showing || e.nativeEvent.isComposing) return false;
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step !== 0) {
      setActive((i) => (i + step + candidates.length) % candidates.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      pick(candidates[Math.min(active, candidates.length - 1)]);
    } else if (e.key === 'Escape') {
      setDismissed(open?.start ?? null);
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  };

  return {
    sync,
    onKeyDown,
    /** The menu is up: the composer's foot line stays quiet until a name is picked. */
    showing,
    menu: showing ? (
      <MentionMenu candidates={candidates} active={active} onHover={setActive} onPick={pick} />
    ) : null,
  };
}

interface MentionMenuProps {
  candidates: Agent[];
  active: number;
  onHover: (index: number) => void;
  onPick: (agent: Agent) => void;
}

function MentionMenu({ candidates, active, onHover, onPick }: MentionMenuProps) {
  return (
    <div
      className="ss-dropdown__menu agent-mention-menu"
      role="listbox"
      aria-label="Mention an agent"
    >
      {candidates.map((agent, i) => (
        <button
          key={agent.id}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={i === active}
          className="ss-dropdown__item agent-mention-menu__item"
          // Keep focus (and the caret) in the field.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(agent)}
        >
          {agent.id === EVERYONE_ID ? (
            // A room's @everyone is the whole room, not an agent: a group
            // glyph on a neutral tile, never someone's initials.
            <span
              className="agent-avatar agent-avatar--mini agent-avatar--tile agent-mention-menu__group"
              aria-hidden
            >
              <CollaboratorsIcon size={10} />
            </span>
          ) : (
            <AgentAvatar id={agent.id} name={agent.name} color={agent.color} size="mini" />
          )}
          <span className="agent-mention-menu__name">
            {agent.id === EVERYONE_ID ? 'Everyone' : agent.name}
          </span>
          {agent.role && <span className="agent-mention-menu__role">{agent.role}</span>}
        </button>
      ))}
    </div>
  );
}

/** A line of your message with its @mentions tinted in each agent's colour. */
export function MentionText({
  text,
  mentions,
  colorOf,
}: {
  text: string;
  mentions?: AgentRef[];
  colorOf: (id: string) => string | undefined;
}) {
  if (!mentions?.length) return <>{text}</>;
  return (
    <>
      {mentionRuns(text, mentions).map((run, i) =>
        run.mention ? (
          <span key={i} className="agent-mention" data-color={colorOf(run.mention.id)}>
            {run.text}
          </span>
        ) : (
          run.text
        )
      )}
    </>
  );
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Tints an agent's @mentions of the people in `members` inside rendered
 * prose, by the backend's rule (`rooms::mentioned_in`): an @ that starts a
 * word, then a whole member name (longest first, any case), never inside an
 * email address, a link or code. Only text nodes change; markup the
 * sanitizer produced is left as it is. Returns how many it tinted.
 */
export function tintMentionsIn(
  root: HTMLElement,
  members: Pick<Agent, 'id' | 'name' | 'color'>[]
): number {
  const named = [...members]
    .filter((m) => m.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  if (named.length === 0) return 0;
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_.@])@(${named.map((m) => escapeRegExp(m.name)).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu'
  );
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('code, pre, a, .agent-mention')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let count = 0;
  for (const node of nodes) {
    const text = node.data;
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const at = (match.index ?? 0) + match[1].length;
      const member = named.find((m) => m.name.toLowerCase() === match[2].toLowerCase());
      if (!member) continue;
      fragment.append(text.slice(last, at));
      const span = document.createElement('span');
      span.className = 'agent-mention';
      span.dataset.color = member.color;
      span.textContent = text.slice(at, at + 1 + match[2].length);
      fragment.append(span);
      last = at + 1 + match[2].length;
      count++;
    }
    fragment.append(text.slice(last));
    node.replaceWith(fragment);
  }
  return count;
}
