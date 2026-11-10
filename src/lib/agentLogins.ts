/**
 * Logins: mirrors `src-tauri/src/agents/logins.rs` and `connections.rs`, the
 * invoke wrappers, and the pure helpers the login card and "What your team
 * needs" are drawn from.
 *
 * An agent asks with `request_login`; one card says which app, which
 * account, what it may do, and the ways in, best first: Connect (a connector,
 * signed in on this Mac, the token in its Keychain or held by claude.ai),
 * Use my browser (Claude in Chrome, every send asks), or an API key. Never a
 * password. Every way in runs on this Mac, whichever device started it.
 *
 * @module lib/agentLogins
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentSecret, SecretRequest } from './agentSecrets';

/** `agent_browser`: the agents' own Chrome on this Mac, signed in by the person (here or from the phone). */
export type LoginMethod =
  | 'existing'
  | 'oauth'
  | 'claude_ai'
  | 'gh'
  | 'agent_browser'
  | 'browser'
  | 'key';

export interface LoginAbility {
  /** `read`, or `write` (send, post, change). */
  id: 'read' | 'write';
  label: string;
}

export interface LoginOption {
  /** Unique on the card: the method, or `existing:<connectionId>`. */
  id: string;
  method: LoginMethod;
  label: string;
  /** What it means: where it signs in, where the sign-in is kept. */
  detail: string;
  connectionId?: string;
}

export type LoginFlowState = 'starting' | 'waiting' | 'failed' | 'cancelled';

/** A way in under way on this Mac. Live only, never stored. */
export interface LoginFlow {
  state: LoginFlowState;
  option: string;
  message?: string;
  startedAt: number;
  /** Started from the phone. */
  fromPhone?: boolean;
  /** The sign-in is on the phone (its sheet, claude.ai there, a device code), not the Mac's browser. */
  onPhone?: boolean;
  /** A device sign-in's one-time code (GitHub), typed at `verificationUri` on either device. */
  userCode?: string;
  verificationUri?: string;
  /** The page this Mac's browser was asked to open: "Open again" and "Copy link". */
  url?: string;
  /** When the browser was last asked to open `url` (unix ms). */
  openedAt?: number;
}

/** After this long with no sign-in back, the card says so instead of spinning (`NO_CALLBACK_MS`). */
export const NO_CALLBACK_MS = 20_000;

/** An app the user chose not to connect; no agent asks for it again until it's turned back on. */
export interface DeclinedApp {
  key: string;
  title: string;
  declinedAt: number;
}

/** What "Not needed" did: the receipt line, and what an Undo turns back on. */
export interface DeclineReceipt {
  keys: string[];
  line: string;
  closed: number;
}

/** What a login card carries (`approval.login`). */
export interface LoginRequest {
  service: string;
  title: string;
  askedAs?: string;
  accountHint?: string;
  why: string;
  abilities: LoginAbility[];
  /** Best first. Empty when nothing here can sign it in. */
  options: LoginOption[];
  /** Why there's no connector, when there isn't one. */
  noConnector?: string;
  /** The masked field, when an API key is a way in. */
  key?: SecretRequest;
  quiet?: boolean;
  replaces?: string;
  flow?: LoginFlow;
  /** Other agents that asked for the same and joined this card: answering it answers them. */
  alsoFor?: string[];
}

export type TeamCardState = 'waiting' | 'connected' | 'skipped' | 'covered';

export interface TeamCard {
  agentId: string;
  agentName: string;
  requestId: string;
  service: string;
  title: string;
  abilities: LoginAbility[];
  state: TeamCardState;
  outcome?: string;
  askedAs?: string;
  flow?: LoginFlow;
}

/** One row of "What your team needs": a service, every agent that asked, one way in. */
export interface TeamNeed {
  key: string;
  title: string;
  services: string[];
  options: LoginOption[];
  noConnector?: string;
  cards: TeamCard[];
  done: boolean;
}

export interface TeamLogins {
  needs: TeamNeed[];
  done: number;
  total: number;
}

export type Access = 'read' | 'full';

export interface ReachConnection {
  connectionId: string;
  service: string;
  title: string;
  account: string;
  access: Access;
  kept: string;
  needsSignIn: boolean;
  lastUsedAt?: number;
  /** One of this Mac's own apps: macOS's one-time ask is said under the section, not per row. */
  macApp?: boolean;
}

export interface Reach {
  connections: ReachConnection[];
  /** Absent for an agent on Codex. */
  /**
   * `on`: its turns get the user's Chrome (the team's browser is set up and on,
   * and this agent's wasn't taken away; never for outside text). `teamOn`: the
   * team's switch. `ownOff`: taken away from this agent.
   */
  browser?: {
    on: boolean;
    teamOn: boolean;
    ownOff: boolean;
    sites: string[];
    /** The Chrome profile (and account) each site was last found signed in to. */
    accounts?: { site: string; browser: string; account?: string }[];
    helperInstalled: boolean;
  };
  secrets: {
    secretId: string;
    name: string;
    purpose: string;
    variables: string[];
    lastUsedAt?: number;
  }[];
  blockedApps: string[];
  /** Apps the user chose not to connect, for the whole team. */
  declined?: DeclinedApp[];
}

/** On the agent itself (`Agent.reach`): browser and blocked apps. */
export interface AgentReachSettings {
  /** The user took its browser away. */
  browserOff?: boolean;
  /** Sites it was given the browser for on a login card. */
  browserSites?: string[];
  /** Claude Code apps kept from its turns, by name there. */
  blockedApps?: string[];
}

export type Removal =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'browser' }
  | { kind: 'browser_on' }
  | { kind: 'browser_site'; site: string }
  | { kind: 'browser_account'; site: string }
  | { kind: 'secret'; secretId: string }
  | { kind: 'block_app'; name: string }
  | { kind: 'unblock_app'; name: string }
  | { kind: 'undecline'; key: string };

export interface Connection {
  id: string;
  service: string;
  title: string;
  account: string;
  kind:
    | { type: 'oauth'; serverUrl: string }
    | { type: 'claude_ai'; serverName: string }
    | { type: 'gh' }
    /** One of this Mac's own apps (`agents/mac_apps.rs`): macOS's permission, no sign-in. */
    | { type: 'mac_app' };
  serverKey: string;
  createdAt: number;
  grants: { agentId: string; access: Access; grantedAt: number }[];
  needsSignIn?: boolean;
  lastUsedAt?: number;
}

/* ------------------------------------------------------------ commands */

export const startLogin = (agentId: string, requestId: string, optionId: string) =>
  invoke<void>('agents_login_start', { agentId, requestId, optionId });
export const cancelLogin = (agentId: string, requestId: string) =>
  invoke<void>('agents_login_cancel', { agentId, requestId });
export const declineLogin = (agentId: string, requestId: string, note?: string) =>
  invoke<void>('agents_login_decline', { agentId, requestId, note: note ?? null });
export const saveLoginKey = (agentId: string, requestId: string, value: string) =>
  invoke<AgentSecret>('agents_login_save_key', { agentId, requestId, value });
export const dismissLogin = (agentId: string, requestId: string) =>
  invoke<void>('agents_login_dismiss', { agentId, requestId });
/** "Not needed" on a card: its app, declined for the whole team and remembered. */
export const loginNotNeeded = (agentId: string, requestId: string) =>
  invoke<DeclineReceipt>('agents_login_not_needed', { agentId, requestId });
/** "Not needed" on rows (`keys`), or "Skip the rest" (no keys: every row still waiting). */
export const loginsNotNeeded = (keys?: string[]) =>
  invoke<DeclineReceipt>('agents_logins_not_needed', { keys: keys ?? null });
/** Undo, or "Turn back on": how many cards came back. */
export const undeclineLogins = (keys: string[]) =>
  invoke<number>('agents_logins_undecline', { keys });
export const declinedApps = () => invoke<DeclinedApp[]>('agents_logins_declined');
/** "Open again": the page a waiting card opened, in this Mac's browser. */
export const reopenLogin = (agentId: string, requestId: string) =>
  invoke<void>('agents_login_reopen', { agentId, requestId });
/** Back in the app: check claude.ai connectors now. */
export const recheckLogins = () => invoke<void>('agents_logins_recheck');
export const teamLogins = (since?: number) =>
  invoke<TeamLogins>('agents_logins_team', { since: since ?? null });
export const connectTeamNeed = (key: string, optionId: string, skip: string[] = []) =>
  invoke<void>('agents_logins_connect', { key, optionId, skip });
export const agentReach = (agentId: string) => invoke<Reach>('agents_reach', { agentId });
export const removeReach = (agentId: string, removal: Removal) =>
  invoke<Reach>('agents_reach_remove', { agentId, removal });
export const listConnections = () => invoke<Connection[]>('agents_connections');
export const deleteConnection = (connectionId: string) =>
  invoke<void>('agents_connection_delete', { connectionId });

/* ------------------------------------------------------------- helpers */

export type LoginPhase =
  | 'choose'
  | 'signing-in'
  | 'failed'
  | 'cancelled'
  | 'connected'
  | 'declined'
  | 'covered';

export interface LoginCardView {
  phase: LoginPhase;
  /** The option the card leads with (a connector, else the browser, else a key). */
  primary?: LoginOption;
  /** The rest, in order. */
  others: LoginOption[];
  /** The ability lines, read first. */
  abilities: LoginAbility[];
  /** What the answered card says. */
  outcome?: string;
  /** The line while it signs in, or why it failed. */
  flowLine?: string;
}

interface ApprovalLike {
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  note?: string;
  choice?: string;
  login?: LoginRequest;
}

/** Which phase a login card is in, and what it shows. */
export function loginCardView(approval: ApprovalLike, agentName: string): LoginCardView {
  const login = approval.login;
  const options = login?.options ?? [];
  const [primary, ...others] = options;
  const base = { primary, others, abilities: login?.abilities ?? [] };
  if (approval.status === 'allowed') {
    return {
      ...base,
      phase: 'connected',
      outcome: approval.choice ?? `Connected · ${agentName} can use it now`,
    };
  }
  if (approval.status === 'denied') {
    const note = approval.note;
    return {
      ...base,
      phase: 'declined',
      outcome:
        note === 'Not needed'
          ? 'Not needed'
          : note
            ? `Declined · “${note}”`
            : `Declined · ${agentName} was told`,
    };
  }
  if (approval.status === 'expired') {
    return { ...base, phase: 'covered', outcome: approval.note ?? 'No longer needed' };
  }
  const flow = login?.flow;
  if (flow?.state === 'starting' || flow?.state === 'waiting') {
    return { ...base, phase: 'signing-in', flowLine: flowLine(flow, login?.title ?? 'it') };
  }
  if (flow?.state === 'failed') {
    return { ...base, phase: 'failed', flowLine: flow.message ?? 'That didn’t work. Try again.' };
  }
  if (flow?.state === 'cancelled') {
    return { ...base, phase: 'cancelled', flowLine: 'Stopped. Choose a way in when you’re ready.' };
  }
  return { ...base, phase: 'choose' };
}

/**
 * Whether the card's lead button retries what just failed. Only when the way
 * in that failed *is* the lead one: after claude.ai fails on a card that leads
 * with the browser, "Try again" on the browser button would say one thing and
 * do another (and the error line itself says "Choose Use my browser").
 */
export function retriesPrimary(
  phase: LoginPhase,
  failedOption: string | undefined,
  primaryId: string
): boolean {
  if (phase !== 'failed' && phase !== 'cancelled') return false;
  return failedOption === undefined || failedOption === primaryId;
}

/**
 * A sign-in opened in this Mac's browser that nothing has come back from
 * for `NO_CALLBACK_MS`: the card says so plainly, with Open again · Copy link.
 */
export function quietSignIn(flow: LoginFlow | undefined, now: number): boolean {
  return (
    flow?.state === 'waiting' &&
    !!flow.url &&
    !flow.onPhone &&
    flow.openedAt !== undefined &&
    now - flow.openedAt >= NO_CALLBACK_MS
  );
}

/** "Didn't see it? …" once it's been quiet: what the card says instead of spinning. */
export function quietLine(flow: LoginFlow): string {
  return flow.option === 'claude_ai'
    ? 'Still not connected. If Claude’s connectors page didn’t open, open it again or copy the link.'
    : 'Nothing has come back yet. If no sign-in page opened, open it again or copy the link.';
}

/** "Gmail's sign-in is open in this Mac's browser." */
export function flowLine(flow: LoginFlow, title: string): string {
  if (flow.state === 'starting')
    return flow.onPhone
      ? `Getting ${title}’s sign-in ready for your phone…`
      : `Getting ${title}’s sign-in ready on this Mac…`;
  return (
    flow.message ??
    (flow.onPhone
      ? `Signing in to ${title} on your phone.`
      : `${title}’s sign-in is open in this Mac’s browser.`)
  );
}

/**
 * One short line under the card's lead button, and beside each of "Other
 * ways": what that way in does, in a sentence. The backend's `detail` (the
 * long account of it) stays on the button's tooltip. The phone says the same
 * for its own ways (`phoneLine`, `mobile/src/lib/loginState.ts`).
 */
export function wayLine(option: LoginOption, title: string): string {
  switch (option.method) {
    case 'browser':
      return 'Uses your Chrome on this Mac. It asks before anything it sends.';
    case 'agent_browser':
      return `You sign in to ${title} in the agents’ own Chrome here. It never sees your password.`;
    case 'oauth':
      return `Opens ${title}’s sign-in in your browser. The token stays on this Mac.`;
    case 'claude_ai':
      return `Adds ${title} to your Claude account on claude.ai.`;
    case 'gh':
      return 'Uses the GitHub sign-in on this Mac. Anything that changes GitHub asks first.';
    case 'existing':
      return 'Already connected. It gets its own permission, which you can take back.';
    case 'key':
      return 'A key made for apps, never a password. Kept in this Mac’s Keychain.';
    default:
      return option.detail;
  }
}

/** "Read and search your email · Draft and send email — it asks you on a card each time". */
export const abilitiesLine = (abilities: LoginAbility[]) =>
  abilities.map((a) => a.label).join(' · ');

/** The ability that sends or changes anything, if it asked for one. */
export const writes = (login: Pick<LoginRequest, 'abilities'>) =>
  login.abilities.some((a) => a.id === 'write');

/** "Recruiter, Mailroom and Calendar". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "4 of 9 connected", or "All 9 done". */
export function progressLine(team: Pick<TeamLogins, 'done' | 'total'>): string {
  if (team.total === 0) return 'Nothing waiting';
  if (team.done === team.total) return `All ${team.total} done`;
  return `${team.done} of ${team.total} connected`;
}

/**
 * The list for some agents only (the "Setting up your team" checklist's):
 * other agents' cards are left off each row, rows left empty go, and the
 * progress counts what's shown. `hidden` on a row is the agents left off, so
 * one Connect there skips them too.
 */
export function scopeTeam(
  team: TeamLogins,
  agentIds: ReadonlySet<string>
): TeamLogins & { needs: (TeamNeed & { hidden: string[] })[] } {
  const needs = team.needs.flatMap((need) => {
    const cards = need.cards.filter((c) => agentIds.has(c.agentId));
    if (cards.length === 0) return [];
    const hidden = [
      ...new Set(need.cards.filter((c) => !agentIds.has(c.agentId)).map((c) => c.agentId)),
    ];
    const done = cards.every((c) => c.state !== 'waiting');
    return [{ ...need, cards, done, hidden }];
  });
  return { needs, done: needs.filter((n) => n.done).length, total: needs.length };
}

/** The agents on a row still waiting, minus the ones unticked. */
export function waitingCards(need: TeamNeed, skipped: ReadonlySet<string> = new Set()) {
  return need.cards.filter((c) => c.state === 'waiting' && !skipped.has(c.agentId));
}

/** A row's lead way in: the first option, which the backend orders best first. */
export const needPrimary = (need: TeamNeed): LoginOption | undefined =>
  need.options.find((o) => o.method !== 'key') ?? need.options[0];

/** What each card state reads as on a row. */
export function teamCardLine(card: TeamCard): string {
  switch (card.state) {
    case 'connected':
      return card.outcome ?? 'Connected';
    case 'skipped':
      return card.outcome === 'Not needed' || !card.outcome ? 'Not needed' : card.outcome;
    case 'covered':
      return card.outcome ?? 'Covered';
    default:
      if (card.flow?.state === 'waiting' || card.flow?.state === 'starting')
        return card.flow.onPhone ? 'Signing in on your phone…' : 'Signing in on this Mac…';
      if (card.flow?.state === 'failed') return card.flow.message ?? 'Didn’t connect';
      return card.abilities.map((a) => a.label).join(' · ');
  }
}

/** "Can read" / "Can read; asks before it sends or changes anything". */
export const accessLabel = (access: Access) =>
  access === 'full' ? 'Can read; asks before it sends or changes anything' : 'Can read';

/** Any sign-in under way on the team list: poll while one runs. */
export const teamBusy = (team: TeamLogins | null | undefined) =>
  !!team?.needs.some((n) =>
    n.cards.some((c) => c.flow?.state === 'starting' || c.flow?.state === 'waiting')
  );
