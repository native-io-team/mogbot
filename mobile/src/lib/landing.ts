/**
 * Where the app opens (the rules are `lib/catchUpTab.ts`'s): Catch up when
 * something waits on you, else Agents. Decided at launch (from the saved
 * copy, then put right once by the Mac's first answer if you haven't moved)
 * and on coming back after a while away; never while you're in a chat, a
 * request or a sheet. A tapped notification or quick action wins: it moves
 * the app first, and nothing here moves it again.
 *
 * Also when you last caught up, for the tab's "Since you last caught up".
 */

import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import {
  landingOnLaunch,
  landingOnReturn,
  settleLaunch,
  SETTLE_MS,
  type Landing,
} from './catchUpTab';
import { feedItems, waitingCount } from './needsYou';
import { readJson, writeJson } from './persist';
import { canCall } from './session';
import { getApp, useApp } from './store';

/** The rows Catch up would show now, counted (its badge's number). */
export function waitingNow(): number {
  const s = getApp();
  if (!s.overview) return 0;
  return waitingCount(
    feedItems(s.overview.agents, s.chats, s.teamSetup, canCall('agents.import.review', s.welcome))
  );
}

let launch: { landed: Landing; at: number } | null = null;

/** The first screen, from what's saved. Once per run. */
export function launchLanding(): Landing {
  launch ??= { landed: landingOnLaunch(waitingNow()), at: Date.now() };
  return launch.landed;
}

/** How long after it settles before a move counts as yours, not the launch's. */
const RETURN_SETTLE_MS = 500;

/**
 * Mounted with the tabs: puts the launch right once the Mac answers, and
 * opens Catch up on coming back after `AWAY_MS` or more.
 */
export function useLanding() {
  const router = useRouter();
  const pathname = usePathname();
  const where = useRef(pathname);
  useEffect(() => {
    where.current = pathname;
  }, [pathname]);

  // The Mac's first answer, within SETTLE_MS of launch.
  const live = useApp((s) => s.link.kind === 'connected' && !!s.overview);
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || !launch) return;
    if (Date.now() - launch.at > SETTLE_MS) {
      settled.current = true;
      return;
    }
    if (!live) return;
    settled.current = true;
    // A beat for the chats the count needs, then decide once.
    const timer = setTimeout(() => {
      if (!launch) return;
      const go = settleLaunch({
        landed: launch.landed,
        pathname: where.current,
        sinceLaunchMs: Date.now() - launch.at,
        waiting: waitingNow(),
      });
      if (go) router.navigate(go);
    }, RETURN_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [live, router]);

  // Coming back: away long enough, and still where you left it.
  useEffect(() => {
    let leftAt: number | null = null;
    let leftFrom = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        leftAt = Date.now();
        leftFrom = where.current;
        return;
      }
      if (state !== 'active' || leftAt === null) return;
      const awayMs = Date.now() - leftAt;
      leftAt = null;
      if (timer) clearTimeout(timer);
      // After a tapped alert has had its moment: if it moved the app, stay.
      timer = setTimeout(() => {
        if (where.current !== leftFrom) return;
        const go = landingOnReturn({ awayMs, pathname: where.current, waiting: waitingNow() });
        if (go) router.navigate(go);
      }, RETURN_SETTLE_MS);
    });
    return () => {
      sub.remove();
      if (timer) clearTimeout(timer);
    };
  }, [router]);
}

// ---- When you last caught up ---------------------------------------------------------

const SEEN_FILE = 'catch-up.json';
let seenAt: number | null | undefined;

/** When Catch up was last left; null if never. */
export async function loadSeen(): Promise<number | null> {
  if (seenAt !== undefined) return seenAt;
  const saved = await readJson<{ seenAt?: number }>(SEEN_FILE).catch(() => null);
  seenAt = typeof saved?.seenAt === 'number' ? saved.seenAt : null;
  return seenAt;
}

export function markSeen(at = Date.now()) {
  seenAt = at;
  void writeJson(SEEN_FILE, { seenAt: at }).catch(() => {});
}
