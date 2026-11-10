/**
 * Keeps the Live Activity (lib/liveActivity.ts) matching the team: started
 * when an agent is busy and the app is in front, updated as that changes,
 * refreshed while the app is open so a long turn never reads as stale, ended
 * when nobody is busy. Only while the Mac is connected: a saved overview is
 * last-known, and a Lock Screen saying "Working…" from it would be a guess.
 * Mounted at the root, and only in a build with the extension.
 */

import * as Linking from 'expo-linking';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import type { LiveActivityFactory } from 'expo-widgets';
import {
  REFRESH_MS,
  STALE_MS,
  activityProps,
  activitySteps,
  liveActivityBuilt,
  type WorkActivityProps,
} from './liveActivity';
import { useApp } from './store';

export function LiveActivityBridge() {
  return liveActivityBuilt() ? <Bridge /> : null;
}

let factory: LiveActivityFactory<WorkActivityProps> | null = null;
/** expo-widgets and @expo/ui, loaded only here: no other build or platform reads them. */
function getFactory() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  factory ??= (require('./liveActivityLayout') as typeof import('./liveActivityLayout')).default;
  return factory;
}

async function show(want: WorkActivityProps | null, foreground: boolean) {
  const f = getFactory();
  const showing = new Map(f.getInstances().map((a) => [a.getId(), a]));
  const stale = () => new Date(Date.now() + STALE_MS);
  for (const step of activitySteps([...showing.keys()], want, foreground)) {
    try {
      if (step.kind === 'start') {
        f.start(step.props, Linking.createURL(`/chat/${step.props.agentId}`), stale());
      } else if (step.kind === 'update') {
        await showing.get(step.id)?.update(step.props, stale());
      } else {
        await showing.get(step.id)?.end('immediate');
      }
    } catch {
      // Live Activities off in Settings, or the system's limit: there's nothing to show.
    }
  }
}

function Bridge() {
  const team = useApp((s) => s.overview?.agents);
  const connected = useApp((s) => s.link.kind === 'connected');
  const want = useMemo(() => (team ? activityProps(team) : null), [team]);
  const key = JSON.stringify(want);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setForeground(s === 'active'));
    return () => sub.remove();
  }, []);
  // While the app is open and someone is busy, push the stale date on.
  useEffect(() => {
    if (!foreground || !want) return;
    const t = setTimeout(() => setRefresh((n) => n + 1), REFRESH_MS);
    return () => clearTimeout(t);
    // `key` is `want`'s content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foreground, key, refresh]);
  useEffect(() => {
    if (!connected) return;
    void show(want, foreground).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, key, foreground, refresh]);
  return null;
}
