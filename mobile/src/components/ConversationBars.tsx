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
import { setupBar } from '../lib/teamSetup';
import { DEMO_BAR, isDemo } from '../lib/demo';
import { pill } from '../lib/connection';
import { useApp } from '../lib/store';
import { BANNER_GRACE_MS, useLinkNow, useLinkState } from './ConnectionPill';
import { BarStack, type BarSpec } from './surfaces';

/**
 * The link, only once it's plainly down: coming back to the app reconnects in
 * about a second, and a bar flashing on every return would say something was
 * wrong when it wasn't.
 */
function useConnectionBar(): BarSpec | null {
  const router = useRouter();
  const state = useLinkState();
  const now = useLinkNow(state.link, 10_000);
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
  onOpenSetup,
}: {
  agent: Agent;
  revising?: ResultRef;
  onStopRevising: () => void;
  /** Go to "Setting up your team" where it sits in the chat. */
  onOpenSetup?: () => void;
}) {
  const teamSetup = useApp((s) => (agent.isMain ? s.teamSetup : null));
  const setup = setupBar(teamSetup);
  const messages = useApp((s) => s.chats[agent.id]?.messages);
  const reviewHere = useApp((s) => !!s.welcome?.methods.includes('agents.import.review'));
  const engines = useApp((s) => s.overview?.engines);
  const cantAsk = engineCantAskBar(agent, engines);
  const connection = useConnectionBar();
  const demo = useDemoBar();
  const bars: BarSpec[] = [];
  if (demo) bars.push(demo);
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
  const importing = importBar(agent, messages, reviewHere);
  if (importing) bars.push({ id: 'import', ...importing, icon: 'square.and.arrow.down' });
  // What's left of setting up the team: the card itself stays in the chat
  // where it was posted, and this brings you to it.
  if (setup) {
    bars.push({
      id: 'setup',
      ...setup,
      ...(onOpenSetup ? { action: { label: 'Continue', onPress: onOpenSetup } } : {}),
    });
  }
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

/** In the demo, always: a sample chat is never to be read as a real one. */
function useDemoBar(): BarSpec | null {
  const demo = useApp((s) => isDemo(s.credentials));
  if (!demo) return null;
  return { id: 'demo', tone: 'info', icon: 'info.circle', ...DEMO_BAR };
}

/** A room's bar stack: only the link, since a room has no engine, driver or import of its own. */
export function RoomBars() {
  const connection = useConnectionBar();
  return <BarStack bars={connection ? [connection] : []} />;
}
