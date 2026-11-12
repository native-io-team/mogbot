/**
 * What the phone can honestly say about the link (docs/mobile.md,
 * "Connection status"). Each layer is ok, a problem, or unknown, and nothing
 * is claimed that wasn't observed: "App open on your Mac" is only ever yes
 * when the server answered, because silence looks the same either way.
 */

import type {
  AgentEngine,
  EngineInfo,
  Known,
  MacSaid,
  RelaySaid,
} from '@shipstudio/companion-protocol';
import { formatAgo } from './agents';
import { computerWords, type ComputerWords } from './computer';
import type { AppState } from './store';

export type Tone = 'ok' | 'problem' | 'unknown' | 'busy';

export interface Pill {
  tone: Tone;
  label: string;
}

type Inputs = Pick<
  AppState,
  'link' | 'refusal' | 'mac' | 'overview' | 'phoneOnline' | 'syncedAt' | 'credentials'
>;

/** One engine agents can run on, as the Mac reported it. */
export interface EngineHealth {
  id: AgentEngine;
  label: string;
  installed: boolean;
  signedIn: Known;
  version?: string;
  /** Agents that run on it. */
  used: number;
  /** One of its agents' last turn failed because it was signed out. */
  failedSignedOut: boolean;
}

/**
 * Every engine the Mac knows, from `overview.engines` (Claude Code and Codex
 * alike). `mac.claude` only fills in what an engine list doesn't say (the
 * three-valued sign-in, the version), and stands in alone for a Mac that
 * sends no engine list.
 */
export function engineHealth(s: Pick<Inputs, 'mac' | 'overview'>): EngineHealth[] {
  const agents = s.overview?.agents ?? [];
  const listed: EngineInfo[] = s.overview?.engines?.length
    ? s.overview.engines
    : s.mac
      ? [
          {
            id: 'claude',
            label: 'Claude Code',
            installed: s.mac.claude.installed,
            signedIn: s.mac.claude.signedIn === 'yes',
            models: [],
          },
        ]
      : [];
  return listed.map((e) => {
    const mine = agents.filter((a) => (a.engine ?? 'claude') === e.id);
    const claude = e.id === 'claude' ? s.mac?.claude : undefined;
    return {
      id: e.id,
      label: e.label,
      installed: e.installed,
      signedIn: claude ? claude.signedIn : e.installed ? (e.signedIn ? 'yes' : 'no') : 'unknown',
      ...(claude?.version ? { version: claude.version } : {}),
      used: mine.length,
      failedSignedOut: mine.some((a) => a.failure?.kind === 'signed_out'),
    };
  });
}

/** An engine that's installed and that agents run on, but signed out: their turns fail. */
const signedOut = (e: EngineHealth) =>
  e.failedSignedOut || (e.installed && e.used > 0 && e.signedIn === 'no');

type RefusedReason = Extract<AppState['link'], { kind: 'refused' }>['reason'];

/**
 * A refusal in two words, by what actually happened. Only `revoked` and
 * `unauthorized` mean the Mac let this phone go; an identity that didn't
 * check out is not a removal, and neither is a Mac that's too old.
 */
const refusedLabel = (c: ComputerWords): Record<RefusedReason, string> => ({
  revoked: 'Not paired any more',
  unauthorized: 'Not paired any more',
  not_your_mac: `Not ${c.your}`,
  mac_reset: 'Pair again',
  pair_again: 'Pair again',
  update_app: 'Update needed',
  update_mac: 'Update needed',
});

/**
 * The Mac let this phone go, or asks it to pair again: Pair again is the
 * one fix (Tailscale wouldn't help). Not for an update, which pairing
 * doesn't fix.
 */
export function needsPairing(link: AppState['link']): boolean {
  if (link.kind !== 'refused') return false;
  return link.reason !== 'update_app' && link.reason !== 'update_mac';
}

/**
 * What a screen with nothing to show says under the pill's words, by the
 * reason: "once it answers" only where it might (a refusal is final until
 * someone does something). `what` is what's missing ("Your agents").
 */
export function problemBody(
  link: AppState['link'],
  macName: string,
  what: string,
  c: ComputerWords = computerWords()
): string {
  if (link.kind !== 'refused')
    return `${what} are on ${macName}. Once it answers, they’ll be here.`;
  switch (link.reason) {
    case 'not_your_mac':
      return `${what} are still on ${macName}. The server at this address couldn’t prove it’s that ${c.noun}, so nothing private was sent to it.`;
    case 'mac_reset':
    case 'pair_again':
    case 'revoked':
    case 'unauthorized':
      return `${what} are still on ${macName}. Pair again to see them here.`;
    case 'update_app':
      return `${what} are on ${macName}. Update this app to see them here.`;
    case 'update_mac':
      return `${what} are on ${macName}. Update the app there to see them here.`;
  }
}

export function pill(s: Inputs, now = Date.now()): Pill {
  const { link } = s;
  const c = computerWords(s.mac?.computer);
  if (link.kind === 'refused') return { tone: 'problem', label: refusedLabel(c)[link.reason] };
  if (link.kind === 'connected') {
    if (link.stuck) return { tone: 'problem', label: `${capNoun(c)} not responding` };
    const out = engineHealth(s).find(signedOut);
    return out
      ? { tone: 'problem', label: `${out.label} signed out` }
      : { tone: 'ok', label: 'Connected' };
  }
  if (s.phoneOnline === false) return { tone: 'problem', label: `Can’t reach ${c.your}` };
  // The Mac answered and said why: that, at once, whatever the calm.
  if (link.macSaid && !(link.kind === 'reconnecting' && link.macClosing)) {
    return { tone: 'problem', label: macSaid(c)[link.macSaid].pill };
  }
  // The first moments of trying read as calm: the phone tries every few
  // seconds with the app in front, and the Mac is usually back by then.
  const calm = link.since != null && now - link.since < CALM_MS;
  // What the relay said of the Mac. Signed out is known at once (it won't
  // pass by itself); offline once the calm is over (a Mac waking reconnects).
  if (link.relaySaid && !(link.kind === 'reconnecting' && link.macClosing)) {
    if (link.relaySaid === 'sign_in_needed')
      return { tone: 'problem', label: relaySaid(c).sign_in_needed.pill };
    if (!calm) return { tone: 'problem', label: relaySaid(c).mac_offline.pill };
  }
  if (link.kind === 'reconnecting') {
    // The Mac's app said it was closing (a quit, an update's restart): waiting for it isn't a fault.
    if (link.macClosing && now - link.lastSeenAt < MAC_CLOSING_WAIT_MS) {
      return { tone: 'busy', label: `Waiting for the app on ${c.your}` };
    }
    if (calm) return { tone: 'busy', label: 'Reconnecting…' };
    // A short blip reads as calm; a long one says plainly that it's not there.
    return now - link.lastSeenAt > 2 * 60_000
      ? { tone: 'problem', label: `Can’t reach ${c.your}` }
      : { tone: 'busy', label: `Reconnecting · last seen ${formatAgo(link.lastSeenAt, now)}` };
  }
  if (calm) return { tone: 'busy', label: 'Connecting…' };
  // A link state from before `since` existed: the old rule, by tries.
  return link.since != null || link.attempt >= 3
    ? { tone: 'problem', label: `Can’t reach ${c.your}` }
    : { tone: 'busy', label: 'Connecting…' };
}

/**
 * What the Mac said as it turned the phone away (`LinkState.macSaid`), in
 * the pill's words and the bar's: each with its one fix, none of them
 * "pair again", and each one the phone keeps trying through.
 */
export const macSaid = (
  c: ComputerWords
): Record<MacSaid, { pill: string; title: string; checks: string[] }> => ({
  other_account: {
    pill: 'Other Tailscale account',
    title: 'Tailscale on this phone is on another account',
    checks: [
      `Open Tailscale on this phone and switch to the account it was paired on, the same account as ${c.your}. It reconnects by itself.`,
    ],
  },
  unavailable: {
    pill: `${capNoun(c)}’s Keychain locked`,
    title: `${c.yourCap} can’t open its Keychain right now`,
    checks: [
      `Log in on ${c.your}: the app there needs its Keychain to prove it’s ${c.your}. It reconnects by itself.`,
      `If you’re logged in, quit the app on ${c.your} and open it again: your agents and chats are kept.`,
    ],
  },
  too_many_connections: {
    pill: `${capNoun(c)} turning phones away`,
    title: `${c.yourCap} has too many connections open`,
    checks: [
      `Close the app on another phone or iPad paired with ${c.your}. It reconnects by itself.`,
      `If that’s not it, quit the app on ${c.your} and open it again: your agents and chats are kept.`,
    ],
  },
});

/** "Mac", "PC", "Computer": the noun at the start of a pill. */
const capNoun = (c: ComputerWords) => c.noun.charAt(0).toUpperCase() + c.noun.slice(1);

/** What the computer said, worded for a computer that hasn't said what it is. */
export const MAC_SAID = macSaid(computerWords());

/** How long trying reads as "Reconnecting…" before it may say it can't reach the Mac. */
export const CALM_MS = 15_000;
/** How long the Mac's app may take to come back after saying it was closing. */
export const MAC_CLOSING_WAIT_MS = 2 * 60_000;

/**
 * The one connection bar at the top of every tab (`ConnectionBar`) and over a
 * chat's composer: what's wrong in plain words, when this phone last heard
 * from the Mac, and what to check. Where the phone can tell, "the app on the
 * Mac isn't responding" (something there took the connection, or the
 * heartbeat came with no answers) is told apart from "can't reach the Mac"
 * (nothing answered: asleep, shut, or Tailscale off). Never the user's fault:
 * every cause is a "may".
 *
 * Null while there's nothing to say: connected and answering, or a refusal
 * (that has its own card, with its one fix).
 */
export interface LinkBar {
  tone: 'busy' | 'problem';
  /** What's wrong, in plain words. */
  title: string;
  /** When it last heard from the Mac, and that what shows is the saved copy. */
  detail: string;
  /** "What to check": the likely causes, most likely first, each with its fix. */
  checks: string[];
  kind: 'offline' | 'connecting' | 'closing' | 'stuck' | 'unreachable' | RelaySaid | MacSaid;
}

/** "Last heard from it 2 min ago", or that nothing has been heard yet. */
function heard(at: number, now: number): string {
  return at ? `Last heard from it ${formatAgo(at, now)}` : 'Not heard from it yet';
}

const SAVED = ' · showing what was saved';

/**
 * What the relay answered for the Mac (`LinkState.relaySaid`), in the pill's
 * words and the bar's. `mac_offline`: it isn't connected to the relay
 * (asleep, off the internet, the app closed); nothing on this phone to fix,
 * so no Tailscale advice. `sign_in_needed`: it's there but signed out, and
 * the relay carries phones only to a signed-in Mac (docs/relay.md, "Accounts").
 */
export const relaySaid = (
  c: ComputerWords
): Record<RelaySaid, { pill: string; title: string; checks: string[] }> => ({
  mac_offline: {
    pill: `${capNoun(c)} offline`,
    title: `${c.yourCap} is offline or asleep`,
    checks: [
      `Wake ${c.your}, with the app open on it.`,
      `If ${c.your} is awake, check it’s online. It reconnects by itself.`,
    ],
  },
  sign_in_needed: {
    pill: `${capNoun(c)} not signed in`,
    title: `${c.yourCap} isn’t signed in`,
    checks: [`On ${c.your}, sign in, or use your own Tailscale instead.`],
  },
});

export const stuckChecks = (c: ComputerWords) => [
  `The app on ${c.your} may be stuck. Quit it and open it again: your agents and chats are kept.`,
  'If it’s in the middle of something big, it may catch up by itself in a minute.',
];

/** The checks for a stuck app, worded for a computer that hasn't said what it is. */
export const STUCK_CHECKS = stuckChecks(computerWords());

export function linkBar(s: Inputs, now = Date.now()): LinkBar | null {
  const { link } = s;
  const c = computerWords(s.mac?.computer);
  const STUCK = stuckChecks(c);
  if (link.kind === 'refused') return null;
  if (link.kind === 'connected') {
    if (!link.stuck) return null;
    return {
      kind: 'stuck',
      tone: 'problem',
      title: `The app on ${c.your} isn’t responding`,
      detail: `${c.yourCap} is connected, but nothing has come back since ${formatAgo(link.stuck, now)}`,
      checks: STUCK,
    };
  }
  const lastSeen = link.kind === 'reconnecting' ? link.lastSeenAt : s.syncedAt || 0;
  const since = `${heard(lastSeen, now)}${lastSeen ? SAVED : ''}`;
  if (s.phoneOnline === false) {
    return {
      kind: 'offline',
      tone: 'problem',
      title: 'This phone is offline',
      detail: since,
      checks: ['Turn on Wi-Fi or mobile data on this phone. It reconnects by itself.'],
    };
  }
  // Tailscale advice only where Tailscale is one of the ways to the Mac: a
  // phone that reaches it only through the relay has nothing of it to check.
  const viaTailscale = !s.credentials || s.credentials.routes.some((r) => r.kind === 'tailscale');
  const unreachable = [
    `${c.yourCap} may be asleep or shut. Wake it, with the app open on it.`,
    ...(viaTailscale
      ? [
          `Tailscale may be off on this phone or on ${c.your}. Open Tailscale and check it’s on, with the same account on both.`,
          // MagicDNS off on the phone: the Mac's *.ts.net name doesn't resolve,
          // which looks exactly like Tailscale being off.
          `If Tailscale is on here, check “Use Tailscale DNS” is on in its settings: ${c.yours} address is a Tailscale name.`,
        ]
      : ['This phone may not be online. Check Wi-Fi or mobile data.']),
    `If the app on ${c.your} is stuck, quit it and open it again.`,
  ];
  const mac = s.mac;
  if (mac && !mac.power.keepAwake && mac.power.onBattery === 'yes') {
    const pct = mac.power.batteryPercent != null ? ` at ${mac.power.batteryPercent}%` : '';
    unreachable[0] = `${c.yourCap} was on battery${pct} with keep-awake off, so it may be asleep. Wake it, with the app open on it.`;
  }
  const stuck = !!link.appStuck;
  const p = pill(s, now);
  if (link.kind === 'reconnecting' && link.macClosing && p.tone === 'busy') {
    return {
      kind: 'closing',
      tone: 'busy',
      title: `Waiting for the app on ${c.your}`,
      detail: `It said it was closing, for an update or a restart · ${heard(lastSeen, now).toLowerCase()}`,
      checks: [`If it isn’t back in a minute or two, open the app on ${c.your}.`],
    };
  }
  if (link.macSaid && p.tone === 'problem') {
    const said = macSaid(c)[link.macSaid];
    return {
      kind: link.macSaid,
      tone: 'problem',
      title: said.title,
      detail: `${c.yourCap} answered · ${heard(lastSeen, now).toLowerCase()}${lastSeen ? SAVED : ''}`,
      checks: said.checks,
    };
  }
  if (link.relaySaid && p.tone === 'problem') {
    const said = relaySaid(c)[link.relaySaid];
    return {
      kind: link.relaySaid,
      tone: 'problem',
      title: said.title,
      detail: since,
      checks: said.checks,
    };
  }
  // Known stuck: said once the calm first seconds are over, not after the
  // two minutes a silent Mac gets before "can't reach" (the phone knows more).
  const calm = link.since != null && now - link.since < CALM_MS;
  if (p.tone !== 'problem' && !(stuck && !calm)) {
    return {
      kind: 'connecting',
      tone: 'busy',
      title: lastSeen ? `Reconnecting to ${c.your}…` : `Connecting to ${c.your}…`,
      detail: since,
      checks: stuck ? STUCK : unreachable,
    };
  }
  if (stuck) {
    return {
      kind: 'stuck',
      tone: 'problem',
      title: `The app on ${c.your} isn’t responding`,
      detail: `${c.yourCap} is reachable · ${heard(lastSeen, now).toLowerCase()}${lastSeen ? SAVED : ''}`,
      checks: STUCK,
    };
  }
  return {
    kind: 'unreachable',
    tone: 'problem',
    title: `Can’t reach ${c.your}`,
    detail: since,
    checks: unreachable,
  };
}

export interface Layer {
  title: string;
  tone: Tone;
  detail: string;
}

const known = (k: Known, yes: string, no: string, unknown: string) =>
  k === 'yes' ? yes : k === 'no' ? no : unknown;

export function layers(
  s: Inputs,
  extra: { latencyMs: number | null; lastSeenAt: number },
  now = Date.now()
): Layer[] {
  const connected = s.link.kind === 'connected';
  const mac = s.mac;
  const c = computerWords(mac?.computer);
  const name = s.credentials?.name ?? c.your;
  const out: Layer[] = [];
  // The link remembers only this run; after a cold start the saved copy's
  // sync time is the last the phone heard, and the agents list says so too.
  const seenAt = extra.lastSeenAt || s.syncedAt || 0;

  out.push({
    title: 'This phone is online',
    tone: s.phoneOnline == null ? 'unknown' : s.phoneOnline ? 'ok' : 'problem',
    detail: s.phoneOnline == null ? 'Unknown' : s.phoneOnline ? 'Yes' : 'No network on this phone',
  });

  if (connected) {
    const route = s.link.kind === 'connected' ? s.link.route : null;
    const via = route === 'tailscale' ? 'Tailscale' : route === 'relay' ? 'the relay' : 'LAN';
    out.push({
      title: `${capNoun(c)} reachable`,
      tone: 'ok',
      detail: `Over ${via}${extra.latencyMs != null ? ` · ${extra.latencyMs} ms` : ''}`,
    });
  } else {
    const seen = seenAt ? `Last seen ${formatAgo(seenAt, now)}` : 'Not seen yet';
    // We can't know why from here; list the likely causes from the last status we had.
    const causes =
      'relaySaid' in s.link && s.link.relaySaid === 'sign_in_needed'
        ? [`${c.yourCap} isn’t signed in, so the relay can’t reach it`]
        : 'relaySaid' in s.link && s.link.relaySaid === 'mac_offline'
          ? [
              `The relay says ${c.your} isn’t connected: it may be asleep, offline, or the app closed`,
            ]
          : s.credentials && !s.credentials.routes.some((r) => r.kind === 'tailscale')
            ? ['It may be asleep, or this phone offline']
            : [`Tailscale may be off on this phone or on ${c.the}`];
    if (mac && !mac.power.keepAwake && mac.power.onBattery === 'yes') {
      const pct = mac.power.batteryPercent != null ? ` at ${mac.power.batteryPercent}%` : '';
      causes.unshift(`It was on battery${pct} with keep-awake off: it may be asleep`);
    }
    out.push({
      title: `${capNoun(c)} reachable`,
      tone: s.link.kind === 'connecting' && s.link.attempt < 3 ? 'unknown' : 'problem',
      detail: `${seen}. ${causes.join('. ')}.`,
    });
  }

  out.push(
    mac && connected
      ? {
          title: `${capNoun(c)} awake`,
          tone: 'ok',
          detail: [
            mac.power.keepAwake ? 'Keep-awake on' : 'Keep-awake off',
            known(mac.power.lidClosedMode, 'lid-closed mode on', 'lid-closed mode off', ''),
            mac.power.onBattery === 'yes'
              ? `on battery${mac.power.batteryPercent != null ? ` (${mac.power.batteryPercent}%)` : ''}`
              : mac.power.onBattery === 'no'
                ? 'on power'
                : '',
          ]
            .filter(Boolean)
            .join(' · '),
        }
      : { title: `${capNoun(c)} awake`, tone: 'unknown', detail: 'Unknown until it answers' }
  );

  out.push({
    title: `App open on ${c.your}`,
    tone: connected ? 'ok' : 'unknown',
    detail: connected
      ? `Yes${mac ? ` · ${mac.appVersion}` : ''}`
      : `Unknown: ${name} isn’t answering, which looks the same whether it’s asleep or closed`,
  });

  out.push(...engineLayers(s, connected ? undefined : { seenAt, now }));

  out.push({
    title: 'Last sync',
    tone: connected && s.syncedAt ? 'ok' : 'unknown',
    detail:
      connected && s.syncedAt
        ? 'Live: changes arrive as they happen'
        : seenAt
          ? `Last synced ${formatAgo(seenAt, now)}`
          : 'Not yet',
  });
  return out;
}

const plural = (n: number) => (n === 1 ? 'Its agent' : `Its ${n} agents`);

/**
 * A layer per engine: one that's installed, or one that agents are set to
 * run on. An engine nobody uses and that isn't installed (Claude Code on a
 * Codex-only Mac) isn't a problem, so it isn't listed.
 *
 * With the Mac away (`stale`), what it last said is only what it last said:
 * every layer is unknown, worded "when last seen", never a green "Signed in".
 */
export function engineLayers(
  s: Pick<Inputs, 'mac' | 'overview'>,
  stale?: { seenAt: number; now: number }
): Layer[] {
  const live = engineLayersLive(s);
  if (!stale) return live;
  const ago = stale.seenAt ? ` · ${formatAgo(stale.seenAt, stale.now)}` : '';
  return live.map((l) => {
    const [first, ...rest] = l.detail.split(' · ');
    const lead = first.split('. ')[0];
    return {
      title: l.title,
      tone: 'unknown',
      detail:
        lead === 'Unknown'
          ? 'Unknown until it answers'
          : `${lead} when last seen${rest.length ? ` · ${rest.join(' · ')}` : ''}${ago}`,
    };
  });
}

function engineLayersLive(s: Pick<Inputs, 'mac' | 'overview'>): Layer[] {
  const engines = engineHealth(s);
  const c = computerWords(s.mac?.computer);
  if (!engines.length) return [{ title: 'What agents run on', tone: 'unknown', detail: 'Unknown' }];
  const shown = engines.filter((e) => e.installed || e.used > 0);
  if (!shown.length) {
    return [
      {
        title: 'What agents run on',
        tone: 'problem',
        detail: `None installed on ${c.the}. Install ${engines.map((e) => e.label).join(' or ')} there`,
      },
    ];
  }
  return shown.map((e): Layer => {
    if (!e.installed) {
      return {
        title: e.label,
        tone: 'problem',
        detail: `Not installed on ${c.the}. ${plural(e.used)} can’t run until it is`,
      };
    }
    if (signedOut(e)) {
      return {
        title: e.label,
        tone: 'problem',
        detail: `Signed out. Sign in on ${c.your} to keep your agents working`,
      };
    }
    return {
      title: e.label,
      // Signed out with no agents on it is nothing to fix; unknown is never shown as fine.
      tone: e.signedIn === 'yes' ? 'ok' : 'unknown',
      detail:
        known(e.signedIn, 'Signed in', 'Signed out', 'Sign-in unknown') +
        (e.version ? ` · ${e.version}` : '') +
        (e.used === 0 ? ' · no agents use it' : ''),
    };
  });
}
