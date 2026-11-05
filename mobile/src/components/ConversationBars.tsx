/**
 * The bar stack above a chat's composer: each piece of this conversation's
 * state, said once, in the fixed order `lib/bars.ts` sets. The header above
 * the chat is identity only, so nothing here is repeated up there.
 */

import type { Agent, ResultRef } from '@shipstudio/companion-protocol';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { engineCantAskBar } from '../lib/agents';
import { drivenBar, importBar, revisingBar } from '../lib/bars';
import { pill } from '../lib/connection';
import { useApp } from '../lib/store';
import { BANNER_GRACE_MS, useLinkState, useNow } from './ConnectionPill';
import { BarStack, type BarSpec } from './surfaces';

/**
 * The link, only once it's plainly down: coming back to the app reconnects in
 * about a second, and a bar flashing on every return would say something was
 * wrong when it wasn't.
 */
function useConnectionBar(): BarSpec | null {
  const router = useRouter();
  const state = useLinkState();
  const now = useNow(10_000);
  const down = state.link.kind !== 'connected';
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!down) return;
    const timer = setTimeout(() => setLate(true), BANNER_GRACE_MS);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [down]);
  if (!down) return null;
  const p = pill(state, now);
  if (!late && p.tone !== 'problem') return null;
  return {
    id: 'connection',
    tone: p.tone === 'problem' ? 'problem' : 'waiting',
    title: p.label,
    detail: 'Saved messages shown',
    onPress: () => router.push('/connection'),
    pressHint: 'Connection details',
  };
}

export function ConversationBars({
  agent,
  revising,
  onStopRevising,
}: {
  agent: Agent;
  revising?: ResultRef;
  onStopRevising: () => void;
}) {
  const messages = useApp((s) => s.chats[agent.id]?.messages);
  const engines = useApp((s) => s.overview?.engines);
  const cantAsk = engineCantAskBar(agent, engines);
  const connection = useConnectionBar();
  const bars: BarSpec[] = [];
  if (connection) bars.push(connection);
  const driven = drivenBar(agent);
  // Only known live: while the Mac is away it's what was last seen, said so.
  if (driven) {
    bars.push({
      id: 'driven',
      ...driven,
      ...(connection ? { detail: 'Last known' } : {}),
      icon: 'terminal',
    });
  }
  const importing = importBar(agent, messages);
  if (importing) bars.push({ id: 'import', ...importing, icon: 'square.and.arrow.down' });
  const changes = revisingBar(revising);
  if (changes) {
    bars.push({
      id: 'revising',
      ...changes,
      icon: 'bubble.left',
      action: { label: "Don't ask for changes", icon: 'xmark', onPress: onStopRevising },
    });
  }
  if (cantAsk) bars.push({ id: 'engine', tone: 'info', ...cantAsk });
  return <BarStack bars={bars} />;
}
