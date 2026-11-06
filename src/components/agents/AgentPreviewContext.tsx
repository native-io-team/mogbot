/**
 * Who opens the preview pane beside the chat, and what it's showing
 * (`AgentPreviewPane`). Kept apart from the pane so cards can open it
 * without pulling the preview machinery into every chat render.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface PreviewRequest {
  agentId: string;
  messageId: string;
  /** Start "Test it" as soon as the site is up. */
  test?: boolean;
  /** One of the message's `localLinks` (its index): preview that link's folder. */
  link?: number;
  /** Bumps on every press, so pressing Preview again re-runs the open. */
  n: number;
  /**
   * Not a site: the agent's page in its own browser, live
   * (`AgentBrowserPane`). The turn it belongs to, so a finished one shows
   * its last picture.
   */
  browser?: { turnStartedAt: number };
}

export interface PreviewOpenOptions {
  test?: boolean;
  link?: number;
}

interface AgentPreviewActions {
  open: (agentId: string, messageId: string, opts?: PreviewOpenOptions) => void;
  /** The agent's own browser, live, in the pane. */
  openBrowser: (agentId: string, turnStartedAt: number) => void;
  close: () => void;
  /** True while the pane is open (read at call time; doesn't re-render cards). */
  isOpen: () => boolean;
}

// Two contexts: cards read only the (stable) actions, so opening the pane
// doesn't re-render every card in the history.
const ActionsContext = createContext<AgentPreviewActions | null>(null);
const CurrentContext = createContext<PreviewRequest | null>(null);

/** Agents mode owns the pane; cards open it through this. */
export function AgentPreviewProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PreviewRequest | null>(null);
  const openRef = useRef(false);
  const open = useCallback((agentId: string, messageId: string, opts?: PreviewOpenOptions) => {
    openRef.current = true;
    setCurrent({ agentId, messageId, test: opts?.test, link: opts?.link, n: Date.now() });
  }, []);
  const openBrowser = useCallback((agentId: string, turnStartedAt: number) => {
    openRef.current = true;
    setCurrent({ agentId, messageId: '', browser: { turnStartedAt }, n: Date.now() });
  }, []);
  const close = useCallback(() => {
    openRef.current = false;
    setCurrent(null);
  }, []);
  const isOpen = useCallback(() => openRef.current, []);
  const actions = useMemo(
    () => ({ open, openBrowser, close, isOpen }),
    [open, openBrowser, close, isOpen]
  );
  return (
    <ActionsContext.Provider value={actions}>
      <CurrentContext.Provider value={current}>{children}</CurrentContext.Provider>
    </ActionsContext.Provider>
  );
}

/** Null outside Agents mode: cards then fall back to opening the project. */
export const useAgentPreview = () => useContext(ActionsContext);

/** What the pane is showing, or null when it's closed. */
export const useAgentPreviewRequest = () => useContext(CurrentContext);
