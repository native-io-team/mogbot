/**
 * Opens an agent's "What it can reach" (Edit agent, scrolled to it) from
 * anywhere in the chat: a connected login card's "What it can reach", the
 * place to change or take back what was just given. Provided by AgentsView;
 * absent (null) in a tree that has no editor, where the link isn't shown.
 *
 * @module components/agents/openReach
 */

import { createContext, useContext } from 'react';

export const OpenReachContext = createContext<((agentId: string) => void) | null>(null);

export const useOpenReach = () => useContext(OpenReachContext);
