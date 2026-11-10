/**
 * The bar stack above a chat's composer: each piece of this conversation's
 * state, said once, in the fixed order `lib/bars.ts` sets. The header above
 * the chat is identity only, so nothing here is repeated up there.
 */

import type { Agent, ResultRef } from '@shipstudio/companion-protocol';
import { useRouter } from 'expo-router';
import { engineCantAskBar } from '../lib/agents';
import { drivenBar, importBar, revisingBar } from '../lib/bars';
import { setupBar } from '../lib/teamSetup';
import { DEMO_BAR, isDemo } from '../lib/demo';
import {
  canPause,
  pauseReading,
  readingBar,
  resumeReading,
  stopReading,
  useReading,
} from '../lib/readAloud';
import { useApp } from '../lib/store';
import { useLinkBar } from './ConnectionPill';
import { BarStack, type BarSpec } from './surfaces';

/**
 * The link, in the same words as the tabs' bar (`useLinkBar`), held back for
 * a calm reconnect; the bar opens the Connection screen.
 */
function useConnectionBar(): BarSpec | null {
  const router = useRouter();
  const { bar } = useLinkBar();
  if (!bar) return null;
  return {
    id: 'connection',
    tone: bar.tone === 'problem' ? 'problem' : 'waiting',
    title: bar.title,
    detail: bar.detail,
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
  const reading = readingBar(
    useReading((s) => s.reading),
    agent.id
  );
  const bars: BarSpec[] = [];
  if (demo) bars.push(demo);
  if (connection) bars.push(connection);
  // A reply read aloud (lib/readAloud.ts): the bar pauses it, its ✕ stops it.
  if (reading) {
    const paused = reading.title === 'Paused';
    bars.push({
      id: 'reading',
      ...reading,
      icon: paused ? 'pause.fill' : 'speaker.wave.2',
      ...(canPause()
        ? {
            onPress: paused ? resumeReading : pauseReading,
            pressHint: paused ? 'Carries on reading' : 'Pauses reading',
          }
        : {}),
      action: { label: 'Stop reading', icon: 'xmark', onPress: stopReading },
    });
  }
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
