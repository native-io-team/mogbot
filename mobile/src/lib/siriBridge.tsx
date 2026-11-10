/**
 * Where a Siri or Shortcuts request becomes a message (lib/siri.ts): mounted
 * at the root once this phone is paired and knows its team, so a request made
 * with the app closed waits for both, then sends and opens the chat.
 */

import * as AppIntents from 'expo-app-intents';
import { useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Alert } from 'react-native';
import { sendOnce } from './session';
import { AGENT_KIND, agentCatalog, planSiriRequest } from './siri';
import { getApp, useApp } from './store';

export function SiriBridge() {
  const ready = useApp((s) => !!s.credentials && !!s.overview);
  if (!ready || !AppIntents.isAvailable()) return null;
  return <Bridge />;
}

function Bridge() {
  const router = useRouter();
  const team = useApp((s) => s.overview?.agents);
  const catalog = useMemo(() => agentCatalog(team ?? []), [team]);
  // Only when a name changes: the same catalog again does nothing natively either.
  const key = JSON.stringify(catalog);
  useEffect(() => {
    void AppIntents.setEntityCatalogAsync(AGENT_KIND, catalog).catch(() => {});
    // `key` is the catalog's content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  AppIntents.useAppIntents(async (pending) => {
    for (const invocation of pending) {
      const plan = planSiriRequest(invocation, getApp().overview?.agents ?? []);
      if (plan.kind === 'skip') continue;
      if (plan.kind === 'drop') {
        Alert.alert('Not sent', plan.reason);
      } else {
        // In the outbox (on disk) at once: from here the send is the app's, as if typed.
        sendOnce(plan.agentId, plan.text, plan.clientId).catch(() => {});
        router.push({ pathname: '/chat/[id]', params: { id: plan.agentId } });
      }
      await AppIntents.removePendingInvocationAsync(invocation.id).catch(() => {});
    }
  });
  return null;
}
