/**
 * What the phone can honestly say about the link (docs/mobile.md,
 * "Connection status"). Each layer is ok, a problem, or unknown, and nothing
 * is claimed that wasn't observed: "App open on your Mac" is only ever yes
 * when the server answered, because silence looks the same either way.
 */

import type { AgentEngine, EngineInfo, Known } from '@shipstudio/companion-protocol';
import { formatAgo } from './agents';
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

export function pill(s: Inputs, now = Date.now()): Pill {
  const { link } = s;
  if (link.kind === 'refused') {
    return link.reason === 'update_app' || link.reason === 'update_mac'
      ? { tone: 'problem', label: 'Update needed' }
      : { tone: 'problem', label: 'Removed from Mac' };
  }
  if (link.kind === 'connected') {
    const out = engineHealth(s).find(signedOut);
    return out
      ? { tone: 'problem', label: `${out.label} signed out` }
      : { tone: 'ok', label: 'Connected' };
  }
  if (s.phoneOnline === false) return { tone: 'problem', label: 'Can’t reach Mac' };
  if (link.kind === 'reconnecting') {
    // A short blip reads as calm; a long one says plainly that it's not there.
    return now - link.lastSeenAt > 2 * 60_000
      ? { tone: 'problem', label: 'Can’t reach Mac' }
      : { tone: 'busy', label: `Reconnecting · last seen ${formatAgo(link.lastSeenAt, now)}` };
  }
  return link.attempt >= 3
    ? { tone: 'problem', label: 'Can’t reach Mac' }
    : { tone: 'busy', label: 'Connecting…' };
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
  const name = s.credentials?.name ?? 'your Mac';
  const mac = s.mac;
  const out: Layer[] = [];

  out.push({
    title: 'This phone is online',
    tone: s.phoneOnline == null ? 'unknown' : s.phoneOnline ? 'ok' : 'problem',
    detail: s.phoneOnline == null ? 'Unknown' : s.phoneOnline ? 'Yes' : 'No network on this phone',
  });

  if (connected) {
    const via = s.link.kind === 'connected' && s.link.route === 'tailscale' ? 'Tailscale' : 'LAN';
    out.push({
      title: 'Mac reachable',
      tone: 'ok',
      detail: `Over ${via}${extra.latencyMs != null ? ` · ${extra.latencyMs} ms` : ''}`,
    });
  } else {
    const seen = extra.lastSeenAt
      ? `Last seen ${formatAgo(extra.lastSeenAt, now)}`
      : 'Not seen yet';
    // We can't know why from here; list the likely causes from the last status we had.
    const causes = ['Tailscale may be off on this phone or on the Mac'];
    if (mac && !mac.power.keepAwake && mac.power.onBattery === 'yes') {
      const pct = mac.power.batteryPercent != null ? ` at ${mac.power.batteryPercent}%` : '';
      causes.unshift(`It was on battery${pct} with keep-awake off: it may be asleep`);
    }
    out.push({
      title: 'Mac reachable',
      tone: s.link.kind === 'connecting' && s.link.attempt < 3 ? 'unknown' : 'problem',
      detail: `${seen}. ${causes.join('. ')}.`,
    });
  }

  out.push(
    mac && connected
      ? {
          title: 'Mac awake',
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
      : { title: 'Mac awake', tone: 'unknown', detail: 'Unknown until it answers' }
  );

  out.push({
    title: 'App open on your Mac',
    tone: connected ? 'ok' : 'unknown',
    detail: connected
      ? `Yes${mac ? ` · ${mac.appVersion}` : ''}`
      : `Unknown: ${name} isn’t answering, which looks the same whether it’s asleep or closed`,
  });

  out.push(...engineLayers(s));

  out.push({
    title: 'Last sync',
    tone: connected && s.syncedAt ? 'ok' : 'unknown',
    detail:
      connected && s.syncedAt
        ? 'Live: changes arrive as they happen'
        : extra.lastSeenAt
          ? `Last synced ${formatAgo(extra.lastSeenAt, now)}`
          : 'Not yet',
  });
  return out;
}

const plural = (n: number) => (n === 1 ? 'Its agent' : `Its ${n} agents`);

/**
 * A layer per engine: one that's installed, or one that agents are set to
 * run on. An engine nobody uses and that isn't installed (Claude Code on a
 * Codex-only Mac) isn't a problem, so it isn't listed.
 */
export function engineLayers(s: Pick<Inputs, 'mac' | 'overview'>): Layer[] {
  const engines = engineHealth(s);
  if (!engines.length) return [{ title: 'Agent engines', tone: 'unknown', detail: 'Unknown' }];
  const shown = engines.filter((e) => e.installed || e.used > 0);
  if (!shown.length) {
    return [
      {
        title: 'Agent engines',
        tone: 'problem',
        detail: `None installed on the Mac. Install ${engines.map((e) => e.label).join(' or ')} there`,
      },
    ];
  }
  return shown.map((e): Layer => {
    if (!e.installed) {
      return {
        title: e.label,
        tone: 'problem',
        detail: `Not installed on the Mac. ${plural(e.used)} can’t run until it is`,
      };
    }
    if (signedOut(e)) {
      return {
        title: e.label,
        tone: 'problem',
        detail: 'Signed out. Sign in on your Mac to keep your agents working',
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
