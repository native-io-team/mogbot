/**
 * A Live Activity (Lock Screen and Dynamic Island) while an agent works: its
 * key colour and name, "Working…" with the time since its turn began, or
 * "Needs your OK" when it waits on you, and "+2 more" when others are going
 * too. One activity for the whole team, never one per agent: the Lock Screen
 * is not a second inbox.
 *
 * **What it may say.** The agent's name (through `redact`, as a notification
 * would) and fixed words. Never a card's text, a step, a reply or anything an
 * agent wrote: the Lock Screen is readable by anyone holding the phone.
 * `activityProps` is the only way props are made, and the test holds it to
 * exactly these fields.
 *
 * **Where it can be built.** ActivityKit needs a widget extension, which
 * expo-widgets adds with its config plugin, and that extension needs an App
 * Group a free Apple team can't always sign. So, as with the share
 * extension, it's only in a build made with `SHIPSTUDIO_LIVE_ACTIVITY=1`
 * (`app.config.ts`, which also sets `extra.liveActivity`); every other build
 * never loads expo-widgets' JS at all.
 *
 * **What it can't do yet.** ActivityKit starts an activity only while the app
 * is in front, and an app that's suspended can't update one: that needs
 * ActivityKit push from the relay, which isn't built. So it starts when you
 * leave an agent working, stays honest by going stale (`STALE_MS`, after
 * which it says to open the app), and is brought up to date, or ended, the
 * moment the app is opened again.
 */

import type { Agent } from '@shipstudio/companion-protocol';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { redact } from './actionable';
import { agentTint } from './accent';
import { needsYou } from './agents';
import { palettes } from './theme';

/** After this long without an update the activity says it may be out of date. */
export const STALE_MS = 10 * 60_000;
/** While the app is open it refreshes this often, so a long turn never looks stale. */
export const REFRESH_MS = 4 * 60_000;

/** Exactly what reaches the Lock Screen: nothing else may be added without the test changing. */
export interface WorkActivityProps {
  agentId: string;
  name: string;
  /** The agent's key colour, dark and light appearance. */
  color: string;
  colorLight: string;
  /** Waiting on you rather than working. */
  needsYou: boolean;
  /** When its turn began (epoch ms), when the Mac said; absent, no clock is shown. */
  since?: number;
  /** Other agents working or waiting on you. */
  more: number;
  /** The "needs you" colour, dark and light (the app's warning role). */
  warn: string;
  warnLight: string;
}

type TeamAgent = Pick<Agent, 'id' | 'name' | 'color' | 'status' | 'pendingApprovals' | 'hidden'>;

const busy = (a: TeamAgent) => a.status.state === 'working' || needsYou(a as Agent);

/**
 * The one activity the team warrants now, or none. Waiting on you comes
 * first (the oldest wait), then the turn that's run longest.
 */
export function activityProps(team: readonly TeamAgent[]): WorkActivityProps | null {
  const going = team.filter((a) => !a.hidden && busy(a));
  if (!going.length) return null;
  const waiting = going.filter((a) => needsYou(a as Agent));
  const pool = waiting.length ? waiting : going;
  const lead = [...pool].sort(
    (a, b) => (a.status.since ?? Infinity) - (b.status.since ?? Infinity)
  )[0];
  return {
    agentId: lead.id,
    name: redact(lead.name).text,
    color: agentTint(lead.color, 'dark'),
    colorLight: agentTint(lead.color, 'light'),
    needsYou: needsYou(lead as Agent),
    ...(lead.status.since ? { since: lead.status.since } : {}),
    more: going.length - 1,
    warn: palettes.dark.accentWarning,
    warnLight: palettes.light.accentWarning,
  };
}

/** Whether this build carries the Live Activity's extension (`extra.liveActivity`). */
export function liveActivityBuilt(
  extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra,
  os: string = Platform.OS
): boolean {
  return os === 'ios' && extra?.liveActivity === true;
}

/** What to do with the activities there are, to show `want`. */
export type ActivityStep =
  | { kind: 'start'; props: WorkActivityProps }
  | { kind: 'update'; id: string; props: WorkActivityProps }
  | { kind: 'end'; id: string };

/**
 * From the activities showing (their ids) to the one wanted: update the
 * first, end the rest; start one only while the app is in front, which is
 * the only time ActivityKit allows it.
 */
export function activitySteps(
  showing: readonly string[],
  want: WorkActivityProps | null,
  foreground: boolean
): ActivityStep[] {
  if (!want) return showing.map((id) => ({ kind: 'end', id }));
  const [keep, ...extra] = showing;
  const steps: ActivityStep[] = extra.map((id) => ({ kind: 'end', id }));
  if (keep) steps.unshift({ kind: 'update', id: keep, props: want });
  else if (foreground) steps.push({ kind: 'start', props: want });
  return steps;
}
