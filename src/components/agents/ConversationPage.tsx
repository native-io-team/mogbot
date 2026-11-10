/**
 * A conversation's living page (`agents/page.rs`): one page pinned under the
 * chat header that the agent, and the routines that run in this
 * conversation, keep current. Its content is blocks, drawn by `AgentBlocks`
 * like any `show`; nothing on it answers.
 *
 * The bar: a fold toggle with the page's title, "Updated 3 min ago · v4"
 * (press it for what changed, version by version; press a version to read
 * it as it was), and Unpin. Unpinned, the page leaves the top of the chat
 * and the header offers Pin page instead (`ConversationPagePin`); the agent
 * keeps it current either way. Folded or not is remembered per
 * conversation on this Mac.
 *
 * @module components/agents/ConversationPage
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronIcon, PinIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { TextButton } from '../primitives/TextButton';
import type { Agent } from '../../lib/agents';
import {
  getPageVersion,
  pageAgo,
  pageBlocks,
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

function readFolded(id: string): boolean {
  try {
    return window.localStorage.getItem(FOLD_KEY + id) === '1';
  } catch {
    return false;
  }
}

function writeFolded(id: string, folded: boolean) {
  try {
    if (folded) window.localStorage.setItem(FOLD_KEY + id, '1');
    else window.localStorage.removeItem(FOLD_KEY + id);
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
  const [older, setOlder] = useState<PageVersion | null>(null);
  const pin = usePinning(agent.id, page.conversation);
  const now = useMinute();
  const toast = useOptionalToast();

  // A new version arriving shows the page as it is now.
  useEffect(() => setOlder(null), [page.version]);

  const shown: PageVersion = older ?? page;
  const set = useMemo(() => pageBlocks(shown), [shown]);

  const fold = () => {
    setFolded(!folded);
    writeFolded(id, !folded);
  };
  const open = async (version: number) => {
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
        <TextButton
          className="agent-page__when"
          aria-expanded={history}
          onClick={() => {
            setHistory(!history);
            if (folded) fold();
          }}
          title="What changed"
        >
          {pageUpdatedLine(page, now)}
        </TextButton>
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
          {history && (
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
                        {h.byRoutine ? ' · by a routine' : ''}
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
          )}
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
  return (
    <IconButton
      variant="ghost"
      icon={<PinIcon size={14} />}
      aria-label={`Pin the page “${page.title}”`}
      title={`Pin “${page.title}” above this conversation`}
      onClick={() => pin(true)}
    />
  );
}
