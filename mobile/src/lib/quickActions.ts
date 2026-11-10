/**
 * Home Screen quick actions (long-press the app icon): message the Chief
 * of Staff, talk to it (Talk, app/talk.tsx), and open the next thing that
 * needs you. Kept in step with the Mac's agents; none while unpaired. A
 * no-op where the native module isn't built in (Expo Go).
 */

import * as QuickActions from 'expo-quick-actions';
import { attentionCounts, nextNeedsYou } from './agents';
import { isDemo } from './demo';
import { quietAgentIds } from './home';
import type { Target } from './notify';
import { getApp, useApp } from './store';

export type QuickTarget = (Target & { compose?: boolean; talk?: boolean }) | 'home';

let signature = '';

function items(): QuickActions.Action[] {
  const s = getApp();
  // None for the demo: the icon's menu outlives the app, and the demo doesn't.
  if (!s.credentials || isDemo(s.credentials) || !s.overview) return [];
  const chief = s.overview.agents.find((a) => a.isMain);
  const { needYou } = attentionCounts(s.overview.agents, s.teamSetup);
  return [
    ...(needYou
      ? [
          {
            id: 'next',
            title: 'Needs your OK',
            subtitle: `${needYou} waiting`,
            icon: 'symbol:exclamationmark.bubble',
          },
        ]
      : []),
    ...(chief
      ? [
          {
            id: 'compose',
            title: `New message to ${chief.name}`,
            icon: 'symbol:square.and.pencil',
          },
          { id: 'talk', title: `Talk to ${chief.name}`, icon: 'symbol:waveform' },
        ]
      : []),
  ];
}

/** Rewrites the icon's menu only when what it would say changed. */
export function syncQuickActions() {
  const sync = () => {
    const next = items();
    const sig = JSON.stringify(next);
    if (sig === signature) return;
    signature = sig;
    void QuickActions.setItems(next).catch(() => {});
  };
  sync();
  return useApp.subscribe((s, prev) => {
    if (s.overview !== prev.overview || s.credentials !== prev.credentials) sync();
  });
}

/** Where an action goes, decided when it's chosen (the list may have moved on). */
export function quickTarget(action: QuickActions.Action): QuickTarget | null {
  const s = getApp();
  const agents = s.overview?.agents ?? [];
  if (action.id === 'compose') {
    const chief = agents.find((a) => a.isMain);
    return chief ? { agentId: chief.id, compose: true } : 'home';
  }
  if (action.id === 'talk') {
    const chief = agents.find((a) => a.isMain);
    return chief ? { agentId: chief.id, talk: true } : 'home';
  }
  if (action.id === 'next')
    return nextNeedsYou(agents, s.chats, quietAgentIds(s.teamSetup)) ?? 'home';
  return null;
}

export const initialQuickAction = () => QuickActions.initial;
export const onQuickAction = (fn: (a: QuickActions.Action) => void) => QuickActions.addListener(fn);
