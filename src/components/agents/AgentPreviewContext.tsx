/**
 * Who opens the preview pane beside the chat, and what it's showing
 * (`AgentPreviewPane`). Kept apart from the pane so cards can open it
 * without pulling the preview machinery into every chat render.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface PreviewRequest {
  agentId: string;
  messageId: string;
  /** Start "Test it" as soon as the site is up. */
  test?: boolean;
  /** Bumps on every press, so pressing Preview again re-runs the open. */
  n: number;
}

interface AgentPreviewActions {
  open: (agentId: string, messageId: string, opts?: { test?: boolean }) => void;
  close: () => void;
}

// Two contexts: cards read only the (stable) actions, so opening the pane
// doesn't re-render every card in the history.
const ActionsContext = createContext<AgentPreviewActions | null>(null);
const CurrentContext = createContext<PreviewRequest | null>(null);

/** Agents mode owns the pane; cards open it through this. */
export function AgentPreviewProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PreviewRequest | null>(null);
  const open = useCallback((agentId: string, messageId: string, opts?: { test?: boolean }) => {
    setCurrent({ agentId, messageId, test: opts?.test, n: Date.now() });
  }, []);
  const close = useCallback(() => setCurrent(null), []);
  const actions = useMemo(() => ({ open, close }), [open, close]);
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
