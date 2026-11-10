/**
 * The chat header's conversation switcher: which of the agent's conversations
 * is on screen, its recent ones (newest first, searchable), "New
 * conversation" and "Rename this conversation". Each conversation has its own
 * engine session and chat; the agent's instructions and memory are shared by
 * all of them (`agents/conversations.rs`). The sidebar stays one row per
 * agent.
 *
 * The trigger carries an attention dot when another conversation has a card
 * waiting on the user, so nothing waits unseen behind the one on screen.
 *
 * @module components/agents/ConversationSwitcher
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronIcon, CommentIcon, PencilIcon, PlusIcon } from '@/components/icons';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { StatusPill } from '../primitives/StatusPill';
import { ModalFrame } from '../primitives/ModalFrame';
import { TextField } from '../primitives/TextField';
import { Button } from '../primitives/Button';
import type { Agent } from '../../lib/agents';
import {
  CONVERSATION_TITLE_CHARS,
  conversationTitle,
  filterConversations,
  loadedConversation,
  othersWaiting,
  type ConversationView,
} from '../../lib/agentConversations';
import {
  openConversation,
  refreshConversations,
  renameConversation,
  startConversation,
  useAgentsSelector,
} from '../../lib/agentsStore';
import { formatAgo } from '../../lib/formatAgo';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useOptionalToast } from '../../contexts/ToastContext';

/** At most this many in the menu before searching; search reaches every one. */
const SHOWN = 12;

interface ConversationSwitcherProps {
  agent: Agent;
  /** The conversation on screen. */
  viewing: string;
  /** Rename opens from ⌘K too. */
  renaming?: boolean;
  onRenamingChange?: (open: boolean) => void;
}

export function ConversationSwitcher({
  agent,
  viewing,
  renaming,
  onRenamingChange,
}: ConversationSwitcherProps) {
  const list = useAgentsSelector((s) => s.conversations[agent.id]);
  const { showToast } = useOptionalToast();
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(0);
  const [renameOpen, setRenameOpen] = useState(false);
  const renameShown = renaming ?? renameOpen;
  const setRename = useCallback(
    (open: boolean) => (onRenamingChange ? onRenamingChange(open) : setRenameOpen(open)),
    [onRenamingChange]
  );
  const current = list?.items.find((c) => c.id === viewing);
  const title = conversationTitle(current ?? { id: viewing, title: '' });
  const waiting = othersWaiting(list, viewing);
  // With only the one conversation every agent starts with, the header's
  // button is its icon alone: nothing to tell apart yet.
  const single = (list?.items.length ?? 1) < 2;
  const working = agent.status.state !== 'idle' && !agent.status.room;
  const workingIn = working ? loadedConversation(agent) : null;

  const fail = useCallback(
    (error: unknown) => showToast(formatCommandError(asCommandError(error)), 'error'),
    [showToast]
  );
  const items = useMemo(() => {
    const all = list?.items ?? [];
    const found = filterConversations(all, query);
    return query ? found : found.slice(0, SHOWN);
  }, [list, query]);
  const hidden = !query && (list?.items.length ?? 0) > SHOWN;

  return (
    <>
      <Dropdown
        portal
        className="agent-conversations"
        menuClassName="agent-model-menu agent-conversations__menu"
        onOpenChange={(open) => {
          if (!open) return;
          setQuery('');
          setNow(Date.now());
          void refreshConversations(agent.id);
        }}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Find a conversation',
          // Enter opens the first match, once there is a search to match.
          onEnter: () => {
            const first = query ? items[0] : undefined;
            if (first) void openConversation(agent.id, first.id);
            return Boolean(first);
          },
        }}
        trigger={(p) => (
          <MenuButton
            {...p}
            tabIndex={0}
            expanded={p['aria-expanded']}
            variant="ghost"
            size="compact"
            className="agent-conversations__trigger"
            title={single ? 'Conversations' : `Conversation: ${title}`}
            aria-label={single ? 'Conversations' : `Conversation: ${title}. Switch conversation`}
          >
            {/* Another conversation waiting is a badge on the icon, never a dot
                after this one's title, which read as this one needing you. */}
            <span className="agent-conversations__icon">
              <CommentIcon size={12} />
              {waiting > 0 && (
                <span
                  className="agent-conversations__badge"
                  role="img"
                  aria-label={`${waiting === 1 ? 'Another conversation needs' : `${waiting} other conversations need`} your OK`}
                />
              )}
            </span>
            {!single && <span className="agent-conversations__title">{title}</span>}
            <ChevronIcon size={10} className={p['aria-expanded'] ? 'chevron-flipped' : undefined} />
          </MenuButton>
        )}
      >
        <DropdownItem
          icon={<PlusIcon size={14} />}
          onSelect={() => void startConversation(agent.id).catch(fail)}
        >
          <span className="agent-model-menu__label">New conversation</span>
        </DropdownItem>
        <DropdownDivider />
        {items.length === 0 ? (
          <p className="agent-model-menu__heading agent-conversations__note">
            {list ? 'No conversation matches.' : 'Reading conversations…'}
          </p>
        ) : (
          !query && <p className="agent-model-menu__heading agent-conversations__heading">Recent</p>
        )}
        {items.map((c) => (
          <DropdownItem
            key={c.id}
            onSelect={() => void openConversation(agent.id, c.id)}
            active={c.id === viewing}
          >
            <span className="agent-model-menu__label agent-conversations__item">
              <span className="agent-conversations__name">{conversationTitle(c)}</span>
              {/* A state is a pill, as in the sidebar and the In flight rows. */}
              {c.waiting > 0 ? (
                <StatusPill tone="waiting" className="agent-conversations__pill">
                  Needs your OK
                </StatusPill>
              ) : c.id === workingIn ? (
                <StatusPill tone="running" className="agent-conversations__pill">
                  Working
                </StatusPill>
              ) : (
                <span className="agent-model-menu__detail agent-conversations__when">
                  {detailOf(c, now)}
                </span>
              )}
            </span>
            <span className="agent-switcher__mark">
              {c.id === viewing && <CheckIcon size={12} aria-label="On screen" />}
            </span>
          </DropdownItem>
        ))}
        {hidden && (
          <p className="agent-model-menu__heading agent-conversations__note">
            Search to find older conversations.
          </p>
        )}
        <DropdownDivider />
        <DropdownItem icon={<PencilIcon size={14} />} onSelect={() => setRename(true)}>
          <span className="agent-model-menu__label">Rename this conversation…</span>
        </DropdownItem>
      </Dropdown>
      {renameShown && (
        <RenameConversation
          agentId={agent.id}
          conversation={current ?? { id: viewing, title: '', named: false }}
          onClose={() => setRename(false)}
          onError={fail}
        />
      )}
    </>
  );
}

/** The small text beside a conversation in the menu (its state is a pill instead). */
function detailOf(c: ConversationView, now: number): string {
  // No time known (0) says nothing rather than "2966w ago".
  return now && c.lastActivityAt > 0 ? formatAgo(c.lastActivityAt, now) : '';
}

function RenameConversation({
  agentId,
  conversation,
  onClose,
  onError,
}: {
  agentId: string;
  conversation: Pick<ConversationView, 'id' | 'title' | 'named'>;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  // What it is called on screen (an older automatic title tidied), not its raw words.
  const [value, setValue] = useState(conversation.title ? conversationTitle(conversation) : '');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const save = (title: string) => {
    setSaving(true);
    renameConversation(agentId, conversation.id, title)
      .then(onClose, onError)
      .finally(() => setSaving(false));
  };
  return (
    <ModalFrame
      isOpen
      onClose={onClose}
      title="Rename conversation"
      className="agent-conversations__rename"
      initialFocusRef={input}
    >
      <form
        className="agent-conversations__rename-form"
        onSubmit={(e) => {
          e.preventDefault();
          save(value.trim());
        }}
      >
        <TextField
          ref={input}
          value={value}
          maxLength={CONVERSATION_TITLE_CHARS}
          aria-label="Conversation name"
          placeholder="Named by its first message"
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="agent-conversations__rename-hint">
          Leave it empty to name it by its first message again.
        </p>
        <div className="agent-conversations__rename-actions">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="strong" type="submit" disabled={saving}>
            Rename
          </Button>
        </div>
      </form>
    </ModalFrame>
  );
}
