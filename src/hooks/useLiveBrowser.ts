/**
 * The frames of an agent's page in its own browser, while someone can see
 * them (`lib/agentsOwnBrowser.ts`, `agent_browser::live`).
 *
 * A long-poll loop, not a timer: each ask waits on the Mac for the next
 * frame, so the rate is the Mac's (about two a second for the chat). It runs
 * only while `enabled`, the window is visible and the element is on screen;
 * otherwise it stops asking and tells the Mac, which stops the screencast.
 *
 * @module hooks/useLiveBrowser
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  liveBrowserFrame,
  rememberLastFrame,
  stopLiveBrowser,
  type LiveBrowserFrame,
} from '../lib/agentsOwnBrowser';

/** After an empty answer (no page yet), or a failure, wait this long. */
const IDLE_RETRY_MS = 1000;
const ERROR_RETRY_MS = 3000;

interface Options {
  enabled: boolean;
  /** The pane beside the chat. */
  large?: boolean;
  /** The turn the frames belong to: its last one is kept for its reply. */
  turnStartedAt?: number;
  /** Paused while this element is off screen. */
  target?: RefObject<Element | null>;
}

/** True while the page is visible (not a hidden window or tab). */
function usePageVisible() {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

/** True while `target` is on screen (or when it can't be told). */
function useOnScreen(target?: RefObject<Element | null>) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = target?.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setOn(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [target]);
  return on;
}

export interface LiveBrowser {
  frame: LiveBrowserFrame | null;
  /** Asking now (enabled, visible, on screen). */
  streaming: boolean;
}

export function useLiveBrowser(agentId: string, opts: Options): LiveBrowser {
  const { enabled, large = false, turnStartedAt, target } = opts;
  const visible = usePageVisible();
  const onScreen = useOnScreen(target);
  const streaming = enabled && visible && onScreen;
  const [frame, setFrame] = useState<LiveBrowserFrame | null>(null);
  const turnRef = useRef(turnStartedAt);
  useEffect(() => {
    turnRef.current = turnStartedAt;
  });

  useEffect(() => {
    if (!streaming) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let after = 0;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    void (async () => {
      while (live) {
        try {
          const f = await liveBrowserFrame(agentId, after, large);
          if (!live) return;
          if (f) {
            after = f.seq;
            setFrame(f);
            if (turnRef.current != null) rememberLastFrame(agentId, turnRef.current, f);
          } else {
            await wait(IDLE_RETRY_MS);
          }
        } catch {
          if (!live) return;
          await wait(ERROR_RETRY_MS);
        }
      }
    })();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      void stopLiveBrowser(agentId, large).catch(() => undefined);
    };
  }, [agentId, large, streaming]);

  return { frame, streaming };
}
