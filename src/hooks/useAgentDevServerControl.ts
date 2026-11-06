/**
 * Answers agents' dev-server requests in this window (`lib/agentDevServer.ts`).
 * Nothing it does changes what the window shows.
 *
 * @module hooks/useAgentDevServerControl
 */
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  AGENT_DEV_SERVER_EVENT,
  answerDevServerRequest,
  handleDevServerRequest,
  type DevServerOwner,
  type DevServerRequest,
} from '../lib/agentDevServer';
import { logger } from '../lib/logger';

export function useAgentDevServerControl(owner: DevServerOwner): void {
  // Requests outlive the render that received them: read the latest owner.
  const ownerRef = useRef(owner);
  useEffect(() => {
    ownerRef.current = owner;
  });
  useEffect(() => {
    const unlisten = listen<DevServerRequest>(AGENT_DEV_SERVER_EVENT, ({ payload }) => {
      logger.info('[Agents] Dev server request', {
        action: payload.action,
        projectPath: payload.projectPath,
      });
      void handleDevServerRequest(ownerRef.current, payload)
        .then((result) => answerDevServerRequest(payload.requestId, result))
        .catch((err: unknown) =>
          logger.warn('[Agents] Could not answer a dev server request', { error: String(err) })
        );
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
}
