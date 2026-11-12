/**
 * Remote access — drive your agents from any MCP-capable AI assistant while
 * this Mac keeps doing the work. (The phone app is the other way in; this is
 * for an assistant you already use.)
 *
 * TypeScript mirror of `src-tauri/src/commands/remote_access.rs`, the invoke
 * wrappers, and the logic the modal and sidebar render: the "before you
 * leave" checklist, the setup steps, and the live summary. All pure functions
 * of the backend's status, so every state is testable without a Mac in it.
 *
 * Two rules the copy follows:
 * - The computer must be on for any of this to work, and the user learns that
 *   first, while still sitting at it — not from their phone when nothing
 *   answers.
 * - Setup is finished when an assistant has actually connected, not when a link
 *   exists. A link nobody has used proves nothing.
 *
 * The link's secret never reaches this code: the backend returns a masked
 * link and copies the real one itself. See docs/remote-access.md.
 *
 * @module lib/remoteAccess
 */

import { invoke } from '@tauri-apps/api/core';

export type TailscaleState =
  | { state: 'notInstalled' }
  | { state: 'needsLogin' }
  | { state: 'connected'; dnsName: string; login?: string }
  | { state: 'unknown'; detail: string };

export interface PowerStatus {
  hasBattery: boolean;
  onAc: boolean | null;
  batteryPercent: number | null;
  charging: boolean | null;
}

export interface RemoteActivity {
  lastRequestMs: number | null;
  lastClient: string | null;
  rejectedRequests: number;
}

export type PushPinState = 'notSet' | 'set' | 'locked';

export interface PublishProgress {
  sinceMs: number | null;
  /** The app already asked Tailscale again by itself. */
  autoRetried: boolean;
  /** The background check stopped waiting; it's over to the user. */
  gaveUp: boolean;
}

export type FunnelProblemKind =
  | 'httpsOff'
  | 'funnelNotAllowed'
  | 'portNotAllowed'
  | 'portsInUse'
  | 'timedOut'
  | 'notConnected'
  | 'other';

export type Reachability =
  | { state: 'reachable' }
  | { state: 'noPublicDns' }
  | { state: 'unreachable'; detail: string };

export interface RemoteAccessStatus {
  supported: boolean;
  enabled: boolean;
  serverRunning: boolean;
  tailscale: TailscaleState;
  funnelOn: boolean;
  funnelApprovalUrl: string | null;
  /** What the approval link switches on: HTTPS certificates or Funnel. */
  funnelApprovalKind?: 'https' | 'funnel' | null;
  funnelError: string | null;
  /** `funnelError` sorted into one cause (tailscale.rs, `classify_funnel_failure`). */
  funnelProblem?: { kind: FunnelProblemKind } | null;
  /**
   * Tailscale's own `BackendState` (`Stopped`, `NeedsLogin`, `Running`…), or
   * `NotRunning` when the Tailscale app isn't running: tells "switched off"
   * from "signed out" from "not open", which `tailscale.state` doesn't.
   */
  tailscaleBackend?: string | null;
  /** The link with its secret masked; present once Tailscale confirms the Funnel. */
  linkMasked: string | null;
  /**
   * Whether a request through the public internet actually reached this
   * computer. Null until the Funnel is on. Only `reachable` counts as live —
   * the Funnel being configured isn't enough (see Reachability in tailscale.rs).
   */
  reachability: Reachability | null;
  /** The wait for the address to go public, and what's been tried. */
  publish: PublishProgress;
  power: PowerStatus;
  keepAwake: boolean;
  lidClosedMode: boolean | null;
  openAtLogin: boolean;
  openAtLoginAvailable: boolean;
  pushPin: PushPinState;
  projects: string[];
  /** An assistant has reached this Mac with the current link at least once. */
  everConnected: boolean;
  activity: RemoteActivity;
}

/** The cheap status the sidebar polls (no Tailscale calls). */
export interface RemoteAccessBrief {
  enabled: boolean;
  serverRunning: boolean;
  keepAwake: boolean;
  power: PowerStatus;
  lidClosedMode: boolean | null;
  activity: RemoteActivity;
}

export interface AuditEntry {
  atMs: number;
  tool: string;
  project: string | null;
  detail: string;
  ok: boolean;
}

export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download/mac';
export const TAILSCALE_MACHINES_URL = 'https://login.tailscale.com/admin/machines';
/** Admin console → DNS, where "HTTPS Certificates" is switched on. */
export const TAILSCALE_DNS_URL = 'https://login.tailscale.com/admin/dns';
/** Admin console → Access controls, where the `funnel` node attribute lives. */
export const TAILSCALE_ACLS_URL = 'https://login.tailscale.com/admin/acls/file';

export const getRemoteAccessStatus = () => invoke<RemoteAccessStatus>('get_remote_access_status');
export const getRemoteAccessBrief = () => invoke<RemoteAccessBrief>('get_remote_access_brief');
export const setRemoteAccessEnabled = (enabled: boolean) =>
  invoke<RemoteAccessStatus>('set_remote_access_enabled', { enabled });
export const setRemoteProject = (projectPath: string, shared: boolean) =>
  invoke<string[]>('set_remote_project', { projectPath, shared });
export const resetRemoteLink = () => invoke<RemoteAccessStatus>('reset_remote_link');
export const republishRemoteLink = () => invoke<RemoteAccessStatus>('republish_remote_link');
export const copyRemoteLink = () => invoke<void>('copy_remote_link');
export const setLidClosedMode = (enabled: boolean) =>
  invoke<RemoteAccessStatus>('set_lid_closed_mode', { enabled });
export const setOpenAtLogin = (enabled: boolean) =>
  invoke<RemoteAccessStatus>('set_open_at_login', { enabled });
export const setRemotePushPin = (pin: string) =>
  invoke<RemoteAccessStatus>('set_remote_push_pin', { pin });
export const clearRemotePushPin = () => invoke<RemoteAccessStatus>('clear_remote_push_pin');
export const getRemoteAudit = (limit = 50) => invoke<AuditEntry[]>('get_remote_audit', { limit });

/**
 * What keeps agents going on this Mac, offered in Agents apart from remote
 * access: hold it awake (the same assertion remote access holds), keep
 * running when windows close, and open at login (remote access's own login
 * item). Each is read back from the thing itself; all macOS only.
 */
export interface StayOn {
  supported: boolean;
  /** True while the Mac is held awake, including by remote access. */
  keepAwake: boolean;
  keepRunning: boolean;
  openAtLogin: boolean;
  /** False in a dev build, which has no installed app to reopen. */
  openAtLoginAvailable: boolean;
}
export type StayOnChange = Partial<Pick<StayOn, 'keepAwake' | 'keepRunning' | 'openAtLogin'>>;
export const getStayOn = () => invoke<StayOn>('get_stay_on');
export const setStayOn = (change: StayOnChange) => invoke<StayOn>('set_stay_on', change);

// ============================================================================
// "Before you leave" — will the computer still be there?
// ============================================================================

export type CheckState = 'ok' | 'warn';

export interface ReadinessItem {
  id: 'power' | 'awake' | 'lid' | 'restart' | 'app';
  state: CheckState;
  title: string;
  detail: string;
}

type ReadinessInput = Pick<
  RemoteAccessStatus,
  'power' | 'keepAwake' | 'lidClosedMode' | 'openAtLogin'
>;

export function readinessItems(s: ReadinessInput): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const { power } = s;

  if (power.onAc === true) {
    items.push({
      id: 'power',
      state: 'ok',
      title: 'Plugged in',
      detail: 'Keep it plugged in while you’re away.',
    });
  } else if (power.onAc === false) {
    items.push({
      id: 'power',
      state: 'warn',
      title: power.batteryPercent !== null ? `On battery (${power.batteryPercent}%)` : 'On battery',
      detail: 'Plug it in. On battery it stops when the battery runs out.',
    });
  } else {
    items.push({
      id: 'power',
      state: 'warn',
      title: 'Power unknown',
      detail: 'Couldn’t tell whether this Mac is plugged in. Make sure it is.',
    });
  }

  items.push(
    s.keepAwake
      ? {
          id: 'awake',
          state: 'ok',
          title: 'Kept awake',
          detail: 'It won’t sleep while remote access is on. The screen can still turn off.',
        }
      : {
          id: 'awake',
          state: 'warn',
          title: 'May fall asleep',
          detail: 'Turning on remote access keeps it awake.',
        }
  );

  if (power.hasBattery) {
    items.push(
      s.lidClosedMode === true
        ? {
            id: 'lid',
            state: 'ok',
            title: 'Runs with the lid closed',
            detail:
              'Keep it plugged in — it keeps working and using battery with the lid shut. Don’t put it in a bag.',
          }
        : {
            id: 'lid',
            state: 'warn',
            title: 'Closing the lid puts it to sleep',
            detail: 'Leave the lid open, or let it run with the lid closed.',
          }
    );
  }

  items.push(
    s.openAtLogin
      ? {
          id: 'restart',
          state: 'ok',
          title: 'Comes back after a restart',
          detail:
            'After a restart (like an overnight macOS update) someone still has to log in once.',
        }
      : {
          id: 'restart',
          state: 'warn',
          title: 'Won’t come back after a restart',
          detail: 'If macOS restarts, remote access stays off until you’re back.',
        }
  );

  items.push({
    id: 'app',
    state: 'ok',
    title: 'Leave the app open',
    detail: 'Quitting it ends remote access. You’ll be asked first.',
  });

  return items;
}

export function warningCount(s: ReadinessInput): number {
  return readinessItems(s).filter((i) => i.state === 'warn').length;
}

export function isReadyToLeave(s: ReadinessInput): boolean {
  return warningCount(s) === 0;
}

// ============================================================================
// Connection
// ============================================================================

export type ConnectionStep =
  | { kind: 'unsupported' }
  | { kind: 'installTailscale' }
  | { kind: 'signInTailscale' }
  /** Installed and signed in, but switched off in its menu. */
  | { kind: 'tailscaleOff' }
  /** The Tailscale app isn't running at all. */
  | { kind: 'openTailscale' }
  | { kind: 'tailscaleProblem'; detail: string }
  | { kind: 'off' }
  /** On, but the app's server isn't running (it stopped, or never came back). */
  | { kind: 'serverStopped' }
  | { kind: 'approveFunnel'; url: string; approves: 'https' | 'funnel' }
  | { kind: 'funnelFailed'; detail: string; problem: FunnelProblemKind }
  | { kind: 'starting' }
  /** Funnel is on, but the internet can't find this Mac yet. */
  | { kind: 'publishing'; linkMasked: string; stage: PublishStage; minutes: number }
  /** Funnel is on and the name resolves, but requests don't get through. */
  | { kind: 'unreachable'; linkMasked: string; detail: string }
  | { kind: 'ready'; linkMasked: string };

/**
 * One state, in the order the blockers have to be cleared: you can't turn on
 * a Funnel you can't sign in to, and "ready" means a request from the public
 * internet actually reached this Mac — not just that Tailscale is
 * configured. Until then the link is shown (so it can be added in advance)
 * with what's still missing.
 */
export type PublishStage = 'waiting' | 'retried' | 'stuck';

/** Where the wait for a public address has got to. */
export function publishStage(p: PublishProgress, minutes: number): PublishStage {
  if (p.gaveUp || minutes >= 10) return 'stuck';
  if (p.autoRetried) return 'retried';
  return 'waiting';
}

export function connectionStep(s: RemoteAccessStatus, now: number = 0): ConnectionStep {
  if (!s.supported) return { kind: 'unsupported' };
  switch (s.tailscale.state) {
    case 'notInstalled':
      return { kind: 'installTailscale' };
    case 'needsLogin':
      if (s.tailscaleBackend === 'Stopped') return { kind: 'tailscaleOff' };
      if (s.tailscaleBackend === 'NotRunning') return { kind: 'openTailscale' };
      return { kind: 'signInTailscale' };
    case 'unknown':
      return { kind: 'tailscaleProblem', detail: s.tailscale.detail };
    case 'connected':
      break;
  }
  if (!s.enabled) return { kind: 'off' };
  // Without the server there is nothing for the link to reach, and waiting on
  // Tailscale would wait forever. Turning it on again starts the server.
  if (!s.serverRunning) return { kind: 'serverStopped' };
  if (s.linkMasked) {
    const r = s.reachability;
    if (r?.state === 'reachable') return { kind: 'ready', linkMasked: s.linkMasked };
    if (r?.state === 'unreachable') {
      return { kind: 'unreachable', linkMasked: s.linkMasked, detail: r.detail };
    }
    const minutes =
      s.publish.sinceMs !== null ? Math.max(0, Math.floor((now - s.publish.sinceMs) / 60_000)) : 0;
    return {
      kind: 'publishing',
      linkMasked: s.linkMasked,
      stage: publishStage(s.publish, minutes),
      minutes,
    };
  }
  if (s.funnelApprovalUrl) {
    return {
      kind: 'approveFunnel',
      url: s.funnelApprovalUrl,
      approves: s.funnelApprovalKind === 'https' ? 'https' : 'funnel',
    };
  }
  if (s.funnelError) {
    return {
      kind: 'funnelFailed',
      detail: s.funnelError,
      problem: s.funnelProblem?.kind ?? 'other',
    };
  }
  return { kind: 'starting' };
}

// ============================================================================
// Problems — every way step 2 of onboarding can fail, as one line + one fix
// ============================================================================

/** What the one fix does when pressed. */
export type RemoteFixAction =
  | { kind: 'openUrl'; label: string; url: string }
  | { kind: 'recheck'; label: string }
  | { kind: 'turnOn'; label: string }
  | { kind: 'republish'; label: string }
  | { kind: 'copyLink'; label: string };

export type RemoteProblemId =
  | 'unsupported'
  | 'tailscaleMissing'
  | 'tailscaleNotRunning'
  | 'tailscaleOff'
  | 'tailscaleSignedOut'
  | 'tailscaleUnreadable'
  | 'remoteOff'
  | 'serverStopped'
  | 'httpsNeedsApproval'
  | 'funnelNeedsApproval'
  | 'httpsOff'
  | 'funnelNotAllowed'
  | 'funnelPortNotAllowed'
  | 'funnelPortsInUse'
  | 'funnelTimedOut'
  | 'funnelFailed'
  | 'publishing'
  | 'publishStuck'
  | 'cantCheckFromHere'
  | 'unreachable'
  | 'notThisApp'
  | 'noAssistantYet';

/**
 * One state of Remote Access that needs the user, as the onboarding
 * screens show it: `line` says what's wrong in plain words, `fix` the one
 * thing to do, and `action` the button that does it (or opens where it's
 * done). `waiting` marks states that clear by themselves (nothing is wrong,
 * it just isn't there yet).
 */
export interface RemoteProblem {
  id: RemoteProblemId;
  line: string;
  fix: string;
  action: RemoteFixAction;
  waiting?: boolean;
}

const recheck: RemoteFixAction = { kind: 'recheck', label: 'Check again' };

/**
 * The one problem standing between this status and a working connection,
 * or null when an assistant can reach this Mac and one already has.
 * Derived from `connectionStep`, so the setup modal and the onboarding
 * screens can never disagree. Documented in docs/remote-access.md,
 * "Failure states".
 */
export function remoteProblem(s: RemoteAccessStatus, now: number = 0): RemoteProblem | null {
  const step = connectionStep(s, now);
  switch (step.kind) {
    case 'unsupported':
      return {
        id: 'unsupported',
        line: 'Remote access only works on a Mac.',
        fix: 'Use an export or paste a reply to bring your agents over instead.',
        action: recheck,
      };
    case 'installTailscale':
      return {
        id: 'tailscaleMissing',
        line: 'Tailscale isn’t on this Mac yet. It gives this Mac its private link.',
        fix: 'Install Tailscale (free), open it, and sign in.',
        action: { kind: 'openUrl', label: 'Get Tailscale', url: TAILSCALE_DOWNLOAD_URL },
      };
    case 'openTailscale':
      return {
        id: 'tailscaleNotRunning',
        line: 'Tailscale is installed but isn’t open.',
        fix: 'Open Tailscale from Applications, then check again.',
        action: recheck,
      };
    case 'tailscaleOff':
      return {
        id: 'tailscaleOff',
        line: 'Tailscale is switched off.',
        fix: 'Click Tailscale in the menu bar and switch it on.',
        action: recheck,
      };
    case 'signInTailscale':
      return {
        id: 'tailscaleSignedOut',
        line: 'Tailscale is signed out.',
        fix: 'Click Tailscale in the menu bar and sign in.',
        action: recheck,
      };
    case 'tailscaleProblem':
      return {
        id: 'tailscaleUnreadable',
        line: `Tailscale gave an answer the app couldn’t read: ${step.detail}`,
        fix: 'Quit and reopen Tailscale, then check again.',
        action: recheck,
      };
    case 'off':
      return {
        id: 'remoteOff',
        line: 'Remote access is off.',
        fix: 'Turn it on to give this Mac its link.',
        action: { kind: 'turnOn', label: 'Turn on remote access' },
      };
    case 'serverStopped':
      return {
        id: 'serverStopped',
        line: 'The link is set up, but the app’s side of it stopped.',
        fix: 'Start it again.',
        action: { kind: 'turnOn', label: 'Start it again' },
      };
    case 'approveFunnel':
      return step.approves === 'https'
        ? {
            id: 'httpsNeedsApproval',
            line: 'Your Tailscale account needs HTTPS turned on, once, for a private link.',
            fix: 'Open the page, allow it, then come back. If it says only an admin can, ask whoever runs your Tailscale.',
            action: { kind: 'openUrl', label: 'Allow in Tailscale', url: step.url },
          }
        : {
            id: 'funnelNeedsApproval',
            line: 'Tailscale needs your OK, once, to make this Mac’s link reachable (it calls this Funnel).',
            fix: 'Open the page, allow it, then come back. If it says only an admin can, ask whoever runs your Tailscale.',
            action: { kind: 'openUrl', label: 'Allow in Tailscale', url: step.url },
          };
    case 'funnelFailed':
      switch (step.problem) {
        case 'httpsOff':
          return {
            id: 'httpsOff',
            line: 'HTTPS certificates are off in your Tailscale account, and the link needs them.',
            fix: 'In Tailscale’s DNS settings, press Enable HTTPS, then try again.',
            action: { kind: 'openUrl', label: 'Open DNS settings', url: TAILSCALE_DNS_URL },
          };
        case 'funnelNotAllowed':
          return {
            id: 'funnelNotAllowed',
            line: 'Your Tailscale account doesn’t allow Funnel for this Mac.',
            fix: 'In Access controls, add the “funnel” attribute for this Mac (an admin has to), then try again.',
            action: { kind: 'openUrl', label: 'Open Access controls', url: TAILSCALE_ACLS_URL },
          };
        case 'portNotAllowed':
          return {
            id: 'funnelPortNotAllowed',
            line: 'Your Tailscale account allows Funnel, but not on port 443.',
            fix: 'In Access controls, let the “funnel” attribute use port 443, then try again.',
            action: { kind: 'openUrl', label: 'Open Access controls', url: TAILSCALE_ACLS_URL },
          };
        case 'portsInUse':
          return {
            id: 'funnelPortsInUse',
            line: 'Something else on this Mac is shared privately on Tailscale, and turning the link on would make it public.',
            fix: 'Stop that other share (tailscale serve) on port 443, 8443 or 10000, then try again.',
            action: { kind: 'turnOn', label: 'Try again' },
          };
        case 'timedOut':
          return {
            id: 'funnelTimedOut',
            line: 'Tailscale didn’t answer in time.',
            fix: 'Check Tailscale is open and connected in the menu bar, then try again.',
            action: { kind: 'turnOn', label: 'Try again' },
          };
        case 'notConnected':
          return {
            id: 'tailscaleSignedOut',
            line: 'Tailscale wasn’t connected when the link was turned on.',
            fix: 'Connect Tailscale from the menu bar, then try again.',
            action: { kind: 'turnOn', label: 'Try again' },
          };
        default:
          return {
            id: 'funnelFailed',
            line: `Tailscale couldn’t make the link: ${step.detail}`,
            fix: 'Try again. If it says the same, open Tailscale and check it’s connected.',
            action: { kind: 'turnOn', label: 'Try again' },
          };
      }
    case 'starting':
      return {
        id: 'publishing',
        line: 'Waiting for Tailscale to confirm the link.',
        fix: 'Nothing to do; this takes a few seconds.',
        action: recheck,
        waiting: true,
      };
    case 'publishing':
      return step.stage === 'stuck'
        ? {
            id: 'publishStuck',
            line: `Tailscale still hasn’t made the link public (${step.minutes} min).`,
            fix: 'Ask Tailscale again.',
            action: { kind: 'republish', label: 'Ask Tailscale again' },
          }
        : {
            id: 'publishing',
            line: 'Tailscale is making the link public. Usually a minute or two.',
            fix: 'You can add the link to your assistant now; it starts working by itself.',
            action: { kind: 'copyLink', label: 'Copy link' },
            waiting: true,
          };
    case 'unreachable': {
      const d = step.detail;
      if (/^public DNS lookup failed/i.test(d)) {
        return {
          id: 'cantCheckFromHere',
          line: 'The app couldn’t check the link: this Mac couldn’t reach the internet.',
          fix: 'Check this Mac is online, then check again.',
          action: recheck,
        };
      }
      if (/not this app/i.test(d)) {
        return {
          id: 'notThisApp',
          line: 'Something else answers at this Mac’s public address.',
          fix: 'Ask Tailscale again so the link points here.',
          action: { kind: 'republish', label: 'Ask Tailscale again' },
        };
      }
      return {
        id: 'unreachable',
        line: 'The link is set up, but a request from the internet didn’t get through yet.',
        fix: 'Ask Tailscale again; if it still fails, check Tailscale is connected.',
        action: { kind: 'republish', label: 'Ask Tailscale again' },
      };
    }
    case 'ready':
      if (s.everConnected) return null;
      return {
        id: 'noAssistantYet',
        line: 'The link works. No assistant has connected with it yet.',
        fix: 'Copy the link, add it to your assistant as a custom connector, and ask it something.',
        action: { kind: 'copyLink', label: 'Copy link' },
        waiting: true,
      };
  }
}

// ============================================================================
// Connecting an assistant — what to paste where
// ============================================================================

export type AssistantId = 'claude' | 'chatgpt' | 'grok' | 'other';

export interface AssistantGuide {
  id: AssistantId;
  name: string;
  /** The steps, in the assistant's own words for its menus. */
  steps: string[];
  /** One line on what plan or role it needs, when it needs one. */
  needs?: string;
  /** Where to start, when the vendor documents the page. */
  url?: string;
  /** What the button that opens `url` says. */
  urlLabel?: string;
}

/**
 * Where to paste the link in each assistant, checked against each one's own
 * help pages on 2026-11-10 (docs/design/import-remote-reliability-2026-11-10.md
 * says what was and wasn't confirmed). Menus move: each guide names the
 * setting so it can be searched for when a label changes. The link is
 * pasted only into the connector's URL field, never into a chat.
 *
 * `url` only where the vendor's own help names it: Claude's connectors page
 * (support.claude.com, "Getting started with custom connectors using remote
 * MCP", read 2026-11-10: claude.ai/customize/connectors) and Grok's
 * (docs.x.ai). ChatGPT's settings have no documented address, so its
 * button opens ChatGPT itself.
 */
export function assistantGuides(appName: string): AssistantGuide[] {
  return [
    {
      id: 'claude',
      name: 'Claude',
      url: 'https://claude.ai/customize/connectors',
      urlLabel: 'Open Claude’s connector settings',
      needs:
        'Any plan (Free allows one custom connector). On Team and Enterprise an owner adds it.',
      steps: [
        'Go to Customize → Connectors, press + Add, then Add custom connector.',
        `Name it ${appName}, paste the link as the remote MCP server URL, and press Continue.`,
        'For authentication choose No sign in (the link carries its own key), then Add.',
        'In a chat, press + → Connectors and switch it on.',
      ],
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      url: 'https://chatgpt.com/',
      urlLabel: 'Open ChatGPT',
      needs:
        'On chatgpt.com, on a paid plan (on Business and Enterprise an admin may need to allow custom MCP servers).',
      steps: [
        'Open Plugins in the sidebar, press Add (or +) and pick Add custom MCP server.',
        `Name it ${appName} and paste the link as the server URL.`,
        'For authentication choose No authentication, tick “I understand and want to continue”, and press Create.',
        `In a new chat, type @ and pick ${appName}.`,
      ],
    },
    {
      id: 'grok',
      name: 'Grok',
      url: 'https://grok.com/connectors',
      urlLabel: 'Open Grok’s connector settings',
      steps: [
        'Go to grok.com/connectors, press New Connector, then Custom.',
        `Name it ${appName} and paste the link as the server URL. It needs no sign-in.`,
        'Ask Grok something about your agents to check it connected.',
      ],
    },
    {
      id: 'other',
      name: 'Another assistant',
      steps: [
        'Find where it adds a custom connector (it may say MCP server, remote MCP or integration).',
        `Name it ${appName} and paste the link as its URL. Choose no sign-in if asked.`,
      ],
    },
  ];
}

// ============================================================================
// Setup steps
// ============================================================================

export type SetupStepId = 'stayOn' | 'connect' | 'projects' | 'pushing' | 'assistant';
export type SetupStepState = 'done' | 'current' | 'upcoming';

/** Choices the user made in this modal that the backend doesn't record. */
export interface SetupChoices {
  /** Read and accepted "this Mac has to stay on". */
  understood: boolean;
  /** Pressed Continue after ticking projects. */
  projectsConfirmed: boolean;
  /** Chose not to allow pushing from the assistant. */
  pushingSkipped: boolean;
}

export interface SetupStep {
  id: SetupStepId;
  title: string;
  state: SetupStepState;
}

const STEP_TITLES: Record<SetupStepId, string> = {
  stayOn: 'This Mac has to stay on',
  connect: 'Give this Mac a private link',
  projects: 'Choose what your assistant can reach',
  pushing: 'Pushing from your assistant',
  assistant: 'Connect your AI assistant',
};

function stepDone(id: SetupStepId, s: RemoteAccessStatus, c: SetupChoices): boolean {
  switch (id) {
    case 'stayOn':
      return c.understood || s.everConnected;
    case 'connect':
      return s.linkMasked !== null;
    case 'projects':
      return s.projects.length > 0 && (c.projectsConfirmed || s.everConnected);
    case 'pushing':
      return s.pushPin !== 'notSet' || c.pushingSkipped || s.everConnected;
    case 'assistant':
      return s.everConnected;
  }
}

/**
 * The setup steps in order, each done, current (the first not done) or
 * upcoming. Steps are done by what's true, not by what was clicked, except
 * where only the user can say (having read a warning, choosing to skip).
 */
export function setupSteps(s: RemoteAccessStatus, c: SetupChoices): SetupStep[] {
  const ids: SetupStepId[] = ['stayOn', 'connect', 'projects', 'pushing', 'assistant'];
  let foundCurrent = false;
  return ids.map((id) => {
    let state: SetupStepState = 'upcoming';
    if (!foundCurrent) {
      if (stepDone(id, s, c)) state = 'done';
      else {
        state = 'current';
        foundCurrent = true;
      }
    }
    return { id, title: STEP_TITLES[id], state };
  });
}

/**
 * Setup is finished once an assistant has connected with the current link —
 * and stays finished if the link later drops, so a problem shows up in the
 * live view (as "Not reachable") instead of throwing the user back into a
 * wizard they already completed. Replacing the link starts setup over.
 */
export function isSetupComplete(s: RemoteAccessStatus, c: SetupChoices): boolean {
  return s.everConnected || setupSteps(s, c).every((step) => step.state === 'done');
}

// ============================================================================
// Live summary
// ============================================================================

export type LiveState = 'live' | 'down' | 'off';

/**
 * "Live" only when the server runs, Tailscale confirms the link, and the
 * internet can actually reach it; anything less is "down". A reachability
 * reading without a link (or a server) is stale, never evidence.
 */
export function liveState(
  s: Pick<RemoteAccessStatus, 'enabled' | 'serverRunning' | 'linkMasked' | 'reachability'>
): LiveState {
  if (!s.enabled) return 'off';
  const reachable =
    s.serverRunning && s.linkMasked !== null && s.reachability?.state === 'reachable';
  return reachable ? 'live' : 'down';
}

export function agoText(ms: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86_400)} d ago`;
}

/**
 * The assistant as people know it. `clientInfo.name` is whatever the client
 * sent (`grok`, `claude-ai`, `openai-mcp`, `cursor-vscode`…); the ones we can
 * recognise get their own name, anything else is shown as sent, with only its
 * first letter raised so it can start a sentence.
 */
export function assistantName(client: string): string {
  const c = client.trim();
  const known: [RegExp, string][] = [
    [/^grok/i, 'Grok'],
    [/^claude/i, 'Claude'],
    [/^(openai|chatgpt)/i, 'ChatGPT'],
    [/^cursor/i, 'Cursor'],
    [/^gemini/i, 'Gemini'],
  ];
  for (const [re, name] of known) if (re.test(c)) return name;
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/**
 * "Grok, last heard from 3 min ago", or null when nothing has asked anything
 * this run. The time is the last request, not the connection, so it says so.
 */
export function describeLastRequest(activity: RemoteActivity, now: number): string | null {
  if (activity.lastRequestMs === null) return null;
  const when = agoText(activity.lastRequestMs, now);
  return activity.lastClient
    ? `${assistantName(activity.lastClient)}, last heard from ${when}`
    : `Last heard from ${when}`;
}

/** A remote action as one readable line. */
export function describeAudit(entry: AuditEntry): string {
  const project = entry.project ? ` in ${entry.project.split('/').pop()}` : '';
  const quote = entry.detail ? `: “${entry.detail}”` : '';
  switch (entry.tool) {
    case 'connected':
      return `${assistantName(entry.detail || 'An assistant')} connected`;
    case 'message_agent':
    case 'send_to_agent': // the tool's name before message_agent; older log lines
      return `Sent a message${project}${quote}`;
    case 'start_agent':
      return `Started a new agent${project}${quote}`;
    case 'close_agent':
      return `Closed an agent${project}${entry.detail ? ` (${entry.detail})` : ''}`;
    case 'republish':
      return entry.ok ? 'Asked Tailscale to publish the address again' : 'Republishing failed';
    case 'press_key':
      return `Pressed ${entry.detail.replace('key ', '') || 'a key'}${project}`;
    case 'read_agent':
      return `Read an agent tab${project}`;
    case 'prepare_push':
      return `Asked to push${project}`;
    case 'confirm_push':
      return entry.ok ? `Pushed${project}` : `Push refused${project}`;
    case 'preview_screenshot':
      return `Took a preview screenshot${project}`;
    case 'create_project':
      return entry.ok ? `Created a new project${quote}` : `Couldn’t create a project${quote}`;
    case 'open_project':
      return `Switched to${project.replace(' in', '')}`;
    case 'push_pin':
    case 'new_link':
      return entry.detail.charAt(0).toUpperCase() + entry.detail.slice(1);
    default:
      return `${entry.tool.replace(/_/g, ' ')}${project}`;
  }
}

/** PIN rules, mirrored from the backend so the field can say why before submitting. */
export function pinProblem(pin: string): string | null {
  if (!/^\d*$/.test(pin)) return 'Digits only.';
  if (pin.length < 6) return 'At least 6 digits.';
  if (pin.length > 12) return 'At most 12 digits.';
  const d = pin.split('').map(Number);
  const same = d.every((n) => n === d[0]);
  const up = d.every((n, i) => i === 0 || n === d[i - 1] + 1);
  const down = d.every((n, i) => i === 0 || n === d[i - 1] - 1);
  if (same || up || down) return 'Too easy to guess.';
  return null;
}
