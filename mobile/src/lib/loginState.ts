/**
 * Login cards on the phone, the pure part: what phase a card is in, what
 * its receipt says, what each line of "What it can reach" and "What your
 * team needs" reads. No transport here, so the tests hold it in Node.
 */

import {
  MAC_FEATURES,
  type AgentReach,
  type Approval,
  type LoginOption,
  type LoginRequest,
  type TeamCard,
  type TeamLogins,
  type WelcomeFrame,
  secretTitle,
} from '@shipstudio/companion-protocol';
import { formatAgo } from './agents';

/** The Mac says it serves login cards (`welcome.features`), and the methods to answer them. */
export const servesLogins = (
  welcome: Pick<WelcomeFrame, 'methods' | 'features'> | null | undefined
) =>
  !!welcome?.features?.includes(MAC_FEATURES.logins) &&
  (welcome.methods as string[]).includes('agents.loginStart');

/** Where a pending card is: choosing, signing in on the Mac, or after a failure. */
export type LoginPhase = 'choose' | 'onMac' | 'failed' | 'answered';

export function loginPhase(approval: Pick<Approval, 'status'>, login: LoginRequest): LoginPhase {
  if (approval.status !== 'pending') return 'answered';
  switch (login.flow?.state) {
    case 'starting':
    case 'waiting':
      return 'onMac';
    case 'failed':
      return 'failed';
    default:
      // Cancelled is back to choosing: nothing happened.
      return 'choose';
  }
}

/** The option the card leads with: the first way in that isn't typing a key. */
export const primaryOption = (login: LoginRequest): LoginOption | undefined =>
  login.options.find((o) => o.method !== 'key') ?? login.options[0];

/** The other ways in, below the primary one. The key option is its own field. */
export const otherOptions = (login: LoginRequest): LoginOption[] => {
  const first = primaryOption(login);
  return login.options.filter((o) => o !== first && o.method !== 'key');
};

export const keyOption = (login: LoginRequest): LoginOption | undefined =>
  login.options.find((o) => o.method === 'key');

/** "Recruiter needs your Gmail", as the Mac titles it, or built when it didn't. */
export const loginTitle = (approval: Approval, login: LoginRequest, agentName: string) =>
  approval.title ||
  `${agentName} needs your ${login.title}${login.accountHint ? ` (${login.accountHint})` : ''}`;

/** What a sign-in under way says on the phone: where it is, and how it's going. */
export function onMacLine(login: LoginRequest): string {
  const live = login.flow?.message;
  if (login.flow?.onPhone) return live ?? `Signing in to ${login.title} here.`;
  const lead = 'Finish signing in on your Mac — it’s open there.';
  return live ? `${lead} ${live}` : lead;
}

/** The Mac lets this phone do the sign-in itself (`logins.phone`). */
export const servesPhoneSignIn = (
  welcome: Pick<WelcomeFrame, 'methods' | 'features'> | null | undefined
) =>
  !!welcome?.features?.includes(MAC_FEATURES.loginsPhone) &&
  (welcome.methods as string[]).includes('agents.loginPhoneBegin');

/**
 * How a way in is done from this phone (docs/agents.md, "From the phone"):
 * - `sheet`: the provider's own sign-in in the system sign-in sheet; the
 *   code goes to the Mac, which makes and keeps the token (our OAuth)
 * - `device`: a one-time code typed at the provider's page, here or
 *   anywhere; the Mac's `gh` keeps the sign-in (GitHub)
 * - `web`: claude.ai opened here to add the connector to the same Claude
 *   account; claude.ai holds that sign-in (Gmail, Calendar, Drive, Slack)
 * - `here`: the site's sign-in in the agents' own Chrome on the Mac, shown
 *   and driven from this phone (`/signin`); the Mac keeps the sign-in
 * - `tap`: nothing to sign in to (an account already connected, the browser)
 * - `key`: the masked field
 * - `mac`: only on the Mac (an older Mac, or no sign-in sheet in this build)
 */
export type PhoneWay = 'sheet' | 'device' | 'web' | 'here' | 'tap' | 'key' | 'mac';

export function phoneWay(
  option: Pick<LoginOption, 'method'>,
  macLetsPhoneSignIn: boolean,
  hasSheet: boolean,
  macLetsSigninHere = false
): PhoneWay {
  switch (option.method) {
    case 'agent_browser':
      return macLetsSigninHere ? 'here' : 'mac';
    case 'existing':
    case 'browser':
      return 'tap';
    case 'key':
      return 'key';
    case 'oauth':
      return macLetsPhoneSignIn && hasSheet ? 'sheet' : 'mac';
    case 'gh':
      return macLetsPhoneSignIn ? 'device' : 'mac';
    case 'claude_ai':
      return macLetsPhoneSignIn ? 'web' : 'mac';
  }
}

/** What a way in means when it's done from this phone, honestly. */
export function phoneDetail(option: LoginOption, way: PhoneWay, title: string): string {
  switch (way) {
    case 'sheet':
      return `Signs in to ${title} here, on its own page. Your Mac makes the token and keeps it in its Keychain; this phone keeps nothing.`;
    case 'device':
      return 'Shows a one-time code to type at github.com/login/device, here or anywhere. GitHub’s sign-in stays on your Mac.';
    case 'web':
      return `Opens claude.ai here to add ${title} to your Claude account (the one your Mac uses). claude.ai holds that sign-in, not your Mac.`;
    case 'here':
      return `${title}’s sign-in opens in the agents’ own Chrome on your Mac and shows here: you sign in by touch, and nothing you type is kept. Your agents then use it signed in.`;
    case 'mac':
      return `${option.detail} Finish on your Mac.`;
    default:
      return option.detail;
  }
}

/**
 * The one short line under a login card's main action: what pressing it
 * does, in a dozen words. The full account of each way in (`phoneDetail`)
 * stays with the other ways, behind "Other ways".
 */
export function phoneLine(option: LoginOption, way: PhoneWay, title: string): string {
  switch (way) {
    case 'sheet':
      return `Sign in to ${title} here. The token stays on your Mac.`;
    case 'device':
      return 'Gives you a one-time code. The sign-in stays on your Mac.';
    case 'web':
      return `Adds ${title} to your Claude account on claude.ai.`;
    case 'here':
      return `Sign in by touch here. Nothing you type is kept.`;
    case 'mac':
      return 'Finish on your Mac.';
    case 'tap':
      return option.method === 'browser'
        ? 'Uses your Chrome on your Mac. It asks before anything it sends.'
        : `Uses the ${title} you already connected.`;
    default:
      return option.detail;
  }
}

/** A finished card's receipt line: its first part leads (`Receipt`). */
export function loginOutcome(approval: Approval, login: LoginRequest, agentName: string): string {
  switch (approval.status) {
    case 'allowed':
      // The Mac writes how: "Connected · Gmail (work@acme.com)", "Using your browser · x.com".
      return approval.choice || `Connected · ${login.title}`;
    case 'denied':
      if (approval.note === 'Not needed') return 'Not needed · Put away; nothing connected';
      return approval.note ? `Declined · “${approval.note}”` : `Declined · ${agentName} was told`;
    case 'expired':
      return approval.note ? `Closed · ${approval.note}` : 'Closed';
    default:
      return 'Not answered';
  }
}

/** "4 of 9 connected", or what's left when nothing's done yet. */
export function teamProgress(team: Pick<TeamLogins, 'done' | 'total'>): string {
  if (team.total === 0) return 'Nothing waiting';
  if (team.done === team.total) return `All ${team.total} done`;
  return `${team.done} of ${team.total} connected`;
}

/** The agents on a row, by name: "Recruiter, Mailroom and Calendar". */
export function agentList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Each line of "What it can reach", as it reads. */
export function reachRows(
  reach: AgentReach
): { key: string; label: string; detail: string; warning?: boolean }[] {
  const rows: { key: string; label: string; detail: string; warning?: boolean }[] = [];
  for (const c of reach.connections) {
    rows.push({
      key: `c:${c.connectionId}`,
      label: c.account && c.account !== c.title ? `${c.title} · ${c.account}` : c.title,
      detail: c.needsSignIn
        ? 'Needs signing in again. Until then it asks on a card.'
        : `${c.access === 'read' ? 'Can read' : 'Can read; asks before it sends or changes anything'}. ${c.kept}.`,
      warning: c.needsSignIn,
    });
  }
  if (reach.browser) {
    const sites = reach.browser.sites.length ? ` For ${reach.browser.sites.join(', ')}.` : '';
    rows.push({
      key: 'browser',
      label: 'Your browser',
      detail: reach.browser.on
        ? `Your own Chrome on your Mac, through Claude in Chrome. It asks before every click, post or send.${sites}${reach.browser.helperInstalled ? '' : ' The extension isn’t set up on your Mac yet.'}`
        : 'Off for this agent',
    });
  }
  for (const s of reach.secrets) {
    // Named by what it's for, as on the desk; the identifier and its
    // variables are the agent's business, not the row's.
    rows.push({
      key: `s:${s.secretId}`,
      label: s.purpose || secretTitle(s.name),
      detail: `A key in your Mac’s Keychain · ${s.lastUsedAt ? `used ${formatAgo(s.lastUsedAt)}` : 'not used yet'}`,
    });
  }
  for (const name of reach.blockedApps) {
    rows.push({ key: `b:${name}`, label: name, detail: 'Kept from this agent' });
  }
  return rows;
}

export const signingIn = (c: Pick<TeamCard, 'flow'>) =>
  c.flow?.state === 'starting' || c.flow?.state === 'waiting';

/** What one agent's line on a team row says. */
export function teamCardLine(c: TeamCard): string {
  const wants = c.abilities.some((a) => a.id === 'write') ? 'read and send' : 'read';
  switch (c.state) {
    case 'connected':
      return `${c.agentName} · ${c.outcome ?? 'Connected'}`;
    case 'skipped':
      return `${c.agentName} · ${c.outcome === 'Not needed' ? 'Not needed' : 'Declined'}`;
    case 'covered':
      return `${c.agentName} · Covered`;
    default:
      if (signingIn(c))
        return `${c.agentName} · ${c.flow?.onPhone ? 'Signing in on your phone…' : 'Signing in on your Mac…'}`;
      if (c.flow?.state === 'failed')
        return `${c.agentName} · ${c.flow.message ?? 'Didn’t finish'}`;
      return `${c.agentName} · to ${wants} ${c.title}`;
  }
}
