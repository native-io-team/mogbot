/**
 * Run `fn` now and every `intervalMs` while the screen is focused, the app
 * is in front and the Mac is connected; never two at once. Live views (a
 * session's screen, the project list) refresh this way rather than by event.
 * In the background there is no timer at all, not one that wakes to skip.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useApp } from './store';

export function usePolling(fn: () => Promise<unknown>, intervalMs: number) {
  const connected = useApp((s) => s.link.kind === 'connected');
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  }, [fn]);
  useFocusEffect(
    useCallback(() => {
      if (!connected) return;
      let running = false;
      let id: ReturnType<typeof setInterval> | undefined;
      const tick = () => {
        if (running || AppState.currentState !== 'active') return;
        running = true;
        void latest.current().finally(() => (running = false));
      };
      // No timer at all while the app is in the background; back in front,
      // it reads at once and carries on.
      const start = () => {
        if (id !== undefined) return;
        tick();
        id = setInterval(tick, intervalMs);
      };
      const stop = () => {
        if (id !== undefined) clearInterval(id);
        id = undefined;
      };
      if (AppState.currentState === 'active') start();
      const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
      return () => {
        sub.remove();
        stop();
      };
    }, [connected, intervalMs])
  );
}
