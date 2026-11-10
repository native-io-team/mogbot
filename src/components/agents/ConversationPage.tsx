/**
 * A conversation's living page (`agents/page.rs`): one page pinned under the
 * chat header that the agent, and the routines that run in this
 * conversation, keep current. Its content is blocks, drawn by `AgentBlocks`
 * like any `show`; nothing on it answers.
 *
 * The bar: a fold toggle with the page's title, "Updated 3 min ago · v4"
 * (press it for what changed, version by version, in a popover off that
 * line, so the page itself doesn't move; press a version to read it as it
 * was), and Unpin. Unpinned, the page leaves the top of the chat and the
 * header offers Pin page instead (`ConversationPagePin`); the agent keeps it
 * current either way. Folded or not is remembered per conversation on this
 * Mac; until the user picks, a short window starts it folded
 * (`SHORT_WINDOW`), so the chat keeps the room.
 *
 * It is furniture, not a reply: a recessed band whose tiles are flat
 * (agents-page.css), and its body scrolls inside a cap of the smaller of
 * 40% of the window and 320px.
 *
 * @module components/agents/ConversationPage
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Dropdown } from '../primitives/Dropdown';
import { ChevronIcon, HistoryIcon, PinIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import type { Agent } from '../../lib/agents';
import {
  getPageVersion,
  pageAgo,
  pageBlocks,
  pageByLine,
  pageChangeLine,
  pageUpdatedLine,
  setPagePinned,
  useConversationPage,
  type ConversationPage as Page,
  type PageVersion,
} from '../../lib/agentPage';
import { AgentBlocks } from './blocks/AgentBlocks';
import { useCommands } from '../../commands/useCommands';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';

const FOLD_KEY = 'agents.page.folded:';

/** A window this short starts a page folded until the user opens it. */
export const SHORT_WINDOW = '(max-height: 820px)';

function isShortWindow(): boolean {
  try {
    return window.matchMedia?.(SHORT_WINDOW).matches ?? false;
  } catch {
    return false;
  }
}

/** The user's own choice for this page, or the window's height when there's none. */
function readFolded(id: string): boolean {
  try {
    const saved = window.localStorage.getItem(FOLD_KEY + id);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    // A private window: nothing remembered, so the window decides.
  }
  return isShortWindow();
}

function writeFolded(id: string, folded: boolean) {
  try {
    window.localStorage.setItem(FOLD_KEY + id, folded ? '1' : '0');
  } catch {
    // A private window: folding just isn't remembered.
  }
}

/** Re-render once a minute, so "3 min ago" stays true. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setTimeout(() => setNow(Date.now()), 60_000 - (Date.now() % 60_000));
    return () => window.clearTimeout(t);
  }, [now]);
  return now;
}

function usePinning(agentId: string, conversation: string | null | undefined) {
  const { showToast } = useOptionalToast();
  return useCallback(
    (pinned: boolean) => {
      if (!conversation) return;
      setPagePinned(agentId, conversation, pinned).catch((e) =>
        showToast(formatCommandError(asCommandError(e)), 'error')
      );
    },
    [agentId, conversation, showToast]
  );
}

interface Props {
  agent: Agent;
  conversation: string | null | undefined;
}

/** The pinned page, under the chat header. Nothing when there's none or it's unpinned. */
export const ConversationPage = memo(function ConversationPage({ agent, conversation }: Props) {
  const page = useConversationPage(agent.id, conversation);
  if (!page || !page.pinned || !conversation) return null;
  return <PagePanel key={`${agent.id}#${conversation}`} agent={agent} page={page} />;
});

function PagePanel({ agent, page }: { agent: Agent; page: Page }) {
  const id = `${agent.id}#${page.conversation}`;
  const [folded, setFolded] = useState(() => readFolded(id));
  const [history, setHistory] = useState(false);
  // An older version opened, for the version the page was on then: a new
  // version arriving shows the page as it is now.
  const [opened, setOpened] = useState<{ v: PageVersion; on: number } | null>(null);
  const older = opened?.on === page.version ? opened.v : null;
  const setOlder = (v: PageVersion | null) => setOpened(v ? { v, on: page.version } : null);
  const pin = usePinning(agent.id, page.conversation);
  const now = useMinute();
  const toast = useOptionalToast();

  const shown: PageVersion = older ?? page;
  const set = useMemo(() => pageBlocks(shown), [shown]);

  const fold = () => {
    setFolded(!folded);
    writeFolded(id, !folded);
    setHistory(false);
  };
  const toggleHistory = () => setHistory(!history);
  // The bar's two controls by name: the page is new, and "Updated … · v4"
  // doesn't read as the way to its versions until it's been pressed once.
  useCommands(
    () => [
      {
        id: 'agents.pageFold',
        title: folded ? `Show the page “${page.title}”` : `Fold the page “${page.title}”`,
        icon: <ChevronIcon size={14} />,
        category: 'action' as const,
        keywords: ['page', 'collapse', 'expand', 'hide', 'living'],
        run: fold,
      },
      {
        id: 'agents.pageVersions',
        title: history ? 'Hide the page’s versions' : 'What changed on this page',
        icon: <HistoryIcon size={14} />,
        category: 'action' as const,
        keywords: ['page', 'versions', 'history', 'changes', 'earlier', 'living'],
        run: toggleHistory,
      },
    ],
    [folded, history, page.title, fold, toggleHistory]
  );
  const open = async (version: number) => {
    setHistory(false);
    // Reading a version means seeing the page.
    if (folded) {
      setFolded(false);
      writeFolded(id, false);
    }
    if (version === page.version) {
      setOlder(null);
      return;
    }
    try {
      const v = await getPageVersion(agent.id, page.conversation, version);
      if (v) setOlder(v);
      else toast.showToast('That version is no longer kept.', 'info');
    } catch (e) {
      toast.showToast(formatCommandError(asCommandError(e)), 'error');
    }
  };

  return (
    <section
      className="agent-page"
      data-folded={folded || undefined}
      aria-label={`Page: ${page.title}`}
    >
      <div className="agent-page__bar">
        <button
          type="button"
          className="agent-page__toggle"
          aria-expanded={!folded}
          onClick={fold}
          title={folded ? 'Show the page' : 'Fold the page'}
        >
          <ChevronIcon size={12} className="agent-page__chevron" />
          <span className="agent-page__title">{page.title}</span>
        </button>
        <Dropdown
          presentation="popover"
          ariaLabel="What changed on this page"
          align="right"
          portal
          open={history}
          onOpenChange={setHistory}
          menuClassName="agent-page__history-menu"
          trigger={(p) => (
            <TextButton
              {...p}
              className="agent-page__when"
              onClick={toggleHistory}
              title="What changed"
            >
              {pageUpdatedLine(page, now)}
            </TextButton>
          )}
        >
          <ol className="agent-page__history" aria-label="Versions">
            {page.history.map((h, i) => {
              const prev = page.history[i + 1];
              return (
                <li key={h.version}>
                  <button
                    type="button"
                    className="agent-page__version"
                    aria-current={h.version === shown.version || undefined}
                    onClick={() => void open(h.version)}
                  >
                    <span className="agent-page__version-head">
                      v{h.version} · {pageAgo(h.at, now)}
                      {pageByLine(h) ? ` · ${pageByLine(h)}` : ''}
                    </span>
                    <span className="agent-page__version-what">
                      {h.version === 1 && !prev
                        ? 'Made the page'
                        : pageChangeLine(h.changes, page.blocks) || 'Updated'}
                      {h.note ? ` — ${h.note}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </Dropdown>
        <IconButton
          variant="ghost"
          size="compact"
          icon={<PinIcon size={14} />}
          aria-label="Unpin the page"
          title="Unpin from the top of this conversation"
          onClick={() => pin(false)}
        />
      </div>
      {!folded && (
        <div className="agent-page__body">
          {older && (
            <p className="agent-page__older">
              v{older.version}, as it was {pageAgo(older.at, now)}.{' '}
              <TextButton onClick={() => setOlder(null)}>Back to v{page.version}</TextButton>
            </p>
          )}
          {set ? (
            <AgentBlocks
              messageId={`page:${page.conversation}:v${shown.version}`}
              agent={agent}
              set={set}
            />
          ) : (
            <p className="agent-page__older">
              This version can’t be shown in this version of the app.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * In the chat header: Pin page, when the conversation has a page the user
 * unpinned. Also ⌘K's "Pin / Unpin this conversation's page".
 */
export function ConversationPagePin({ agent, conversation }: Props) {
  const page = useConversationPage(agent.id, conversation);
  const pin = usePinning(agent.id, conversation);
  const has = !!page;
  const pinned = !!page?.pinned;
  useCommands(
    () => [
      {
        id: 'agents.pagePin',
        title: pinned ? 'Unpin this conversation’s page' : 'Pin this conversation’s page',
        icon: <PinIcon size={14} />,
        category: 'action',
        keywords: ['page', 'tracker', 'board', 'pinned', 'living'],
        when: () => has,
        run: () => pin(!pinned),
      },
    ],
    [has, pinned, pin]
  );
  if (!page || page.pinned) return null;
  // A word beside the pin, as Routines and Model have: the pin alone also
  // means "pin this agent" in the sidebar. Narrow, the word goes and the
  // name keeps it.
  return (
    <Button
      tabIndex={0}
      variant="ghost"
      className="agent-chat__action"
      leftIcon={<PinIcon size={14} />}
      aria-label={`Pin the page “${page.title}”`}
      title={`Pin “${page.title}” above this conversation`}
      onClick={() => pin(true)}
    >
      <span className="agent-chat__action-word">Page</span>
    </Button>
  );
}
