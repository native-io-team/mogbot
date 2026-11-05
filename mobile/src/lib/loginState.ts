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
} from '@shipstudio/companion-protocol';

/** The Mac says it serves login cards (`welcome.features`), and the methods to answer them. */
export const servesLogins = (welcome: Pick<WelcomeFrame, 'methods' | 'features'> | null | undefined) =>
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

/** "Hiring needs your Gmail", as the Mac titles it, or built when it didn't. */
export const loginTitle = (approval: Approval, login: LoginRequest, agentName: string) =>
  approval.title ||
  `${agentName} needs your ${login.title}${login.accountHint ? ` (${login.accountHint})` : ''}`;

/** What a sign-in under way says on the phone: it's on the Mac, and how it's going. */
export function onMacLine(login: LoginRequest): string {
  const live = login.flow?.message;
  const lead = 'Finish signing in on your Mac — it’s open there.';
  return live ? `${lead} ${live}` : lead;
}

/** A finished card's receipt line: its first part leads (`Receipt`). */
export function loginOutcome(approval: Approval, login: LoginRequest, agentName: string): string {
  switch (approval.status) {
    case 'allowed':
      // The Mac writes how: "Connected · Gmail (work@acme.com)", "Using your browser · x.com".
      return approval.choice || `Connected · ${login.title}`;
    case 'denied':
      if (approval.note === 'Not needed') return 'Not needed · Put away; nothing connected';
      return approval.note
        ? `Declined · “${approval.note}”`
        : `Declined · ${agentName} was told`;
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

/** The agents on a row, by name: "Hiring, Inbox Zero and Calendar". */
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
        ? 'Needs signing in again on your Mac'
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
    rows.push({
      key: `s:${s.secretId}`,
      label: s.name,
      detail: `${s.variables.join(', ')} · in your Mac’s Keychain. ${s.purpose}`,
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
      if (signingIn(c)) return `${c.agentName} · Signing in on your Mac…`;
      if (c.flow?.state === 'failed') return `${c.agentName} · ${c.flow.message ?? 'Didn’t finish'}`;
      return `${c.agentName} · to ${wants} ${c.title}`;
  }
}
