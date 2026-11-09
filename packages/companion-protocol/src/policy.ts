/**
 * What each agent may do (`agents/policy.rs`), worded once for the desk and
 * the phone: the wire types of "What it can do" and of a "Change … settings?"
 * card (`propose_settings_change`), and the words both show. Changing
 * settings happens in chat: an agent proposes, the user allows on a card.
 */

import type { AgentIndependence } from './model';

export type ProjectScope = 'all' | 'listed' | 'none';
export type ProjectHow = 'read_only' | 'copy' | 'direct';
export type ProjectElsewhere = 'read' | 'change';
export type AppsMode = 'all' | 'only' | 'none';
export type PolicyPreset = 'trusted' | 'balanced' | 'locked';

export interface PolicyProjects {
  scope: ProjectScope;
  listed?: string[];
  how: ProjectHow;
  elsewhere: ProjectElsewhere;
}

export interface PolicyFolder {
  path: string;
  write: boolean;
}

export interface PolicyApps {
  mode: AppsMode;
  only?: string[];
}

export interface PolicyEffective {
  projects: PolicyProjects;
  folders: PolicyFolder[];
  apps: PolicyApps;
  browser: boolean;
  independence: AgentIndependence;
  admin: boolean;
  teamRules: string[];
  ownRules: string[];
  /** Sends under the user's name wait for their OK on the exact text, at every level. */
  outwardTextNeedsOk: boolean;
  /** The dimensions it has its own value for. */
  own: string[];
}

/** One line of "What it can do". */
export interface PolicyLine {
  key:
    | 'projects'
    | 'folders'
    | 'apps'
    | 'browser'
    | 'independence'
    | 'admin'
    | 'outward_text'
    | 'rules';
  label: string;
  value: string;
  /** `app`: the app stops it. `prompt`: instructions the agent is given. */
  enforced: 'app' | 'prompt';
  /** The team's value rather than its own. */
  team: boolean;
}

export interface AgentPolicyView {
  agentId: string;
  preset?: PolicyPreset;
  sameAsTeam: boolean;
  lines: PolicyLine[];
  effective: PolicyEffective;
}

export interface PresetInfo {
  id: PolicyPreset;
  label: string;
  blurb: string;
}

export interface TeamPolicyView {
  preset?: PolicyPreset;
  presets: PresetInfo[];
  lines: PolicyLine[];
  team: {
    projects: PolicyProjects;
    folders: PolicyFolder[];
    apps: PolicyApps;
    browser: boolean;
    rules: string[];
    outwardTextNeedsOk: boolean;
  };
  /** Names of agents with settings of their own. */
  ownSettings: string[];
}

/** What to change: a base (preset, like, sameAsTeam), then fields on top. */
export interface PolicyChange {
  preset?: PolicyPreset;
  like?: string;
  sameAsTeam?: boolean;
  scope?: ProjectScope;
  addProjects?: string[];
  removeProjects?: string[];
  how?: ProjectHow;
  elsewhere?: ProjectElsewhere;
  addFolders?: PolicyFolder[];
  removeFolders?: string[];
  apps?: AppsMode;
  addApps?: string[];
  removeApps?: string[];
  browser?: boolean;
  /** A level, or `team`. */
  independence?: AgentIndependence | 'team';
  admin?: boolean;
  addRules?: string[];
  removeRules?: string[];
  /** Hold sends under the user's name for their OK on the exact text. */
  outwardTextNeedsOk?: boolean;
}

export type PolicyTarget =
  | { kind: 'team'; everyone?: boolean }
  | { kind: 'agent'; agentId: string };

/** Agents changed the same way, on a "Change … settings?" card. */
export interface SettingsGroup {
  who: string;
  agentIds: string[];
  changes: string[];
}

export interface SettingsProposal {
  targets: PolicyTarget[];
  change: PolicyChange;
  version: number;
  groups: SettingsGroup[];
  why?: string;
  /** Some of it is a rule: words, not something the app stops. */
  hasRules?: boolean;
  /** Switches for this whole Mac instead of agents' settings ("Fix stopped previews", keep awake, keep running, open at login, Your Chrome). */
  mac?: {
    fixPreviews?: boolean;
    keepAwake?: boolean;
    keepRunning?: boolean;
    openAtLogin?: boolean;
    /** Agents may use the user's own Chrome through the app's extension. */
    yourChrome?: boolean;
  };
  /** Apps already connected on this Mac, given to or taken from agents; each `line` is also in `groups`. */
  grants?: {
    agentId: string;
    connectionId: string;
    before?: 'read' | 'full';
    /** Absent: taken away. */
    access?: 'read' | 'full';
    line: string;
  }[];
}

export const PRESET_LABEL: Record<PolicyPreset, string> = {
  trusted: 'I trust my agents',
  balanced: 'Balanced',
  locked: 'Locked down',
};

export const HOW_LABEL: Record<ProjectHow, string> = {
  read_only: 'Read only',
  copy: 'Its own copy',
  direct: 'Directly',
};

/** Under the lines: which the app enforces and which are words. Never claimed wider. */
export const ENFORCED_NOTE =
  'The app enforces these, except independence and rules: those are instructions the agent is given.';

/** A rule on a card: said plainly, every time one is added. */
export const RULES_NOTE =
  'Rules are instructions the agent is given; the app doesn’t stop it breaking one.';

/** Typed into the Chief's composer by "Change in chat": nothing is sent. */
export function chatDraft(agentName: string | null): string {
  return agentName ? `Change what ${agentName} can do: ` : 'Change what my agents can do: ';
}

/** "Reset everyone to Balanced": what the button and its confirm say. */
export function resetLabel(preset: PolicyPreset): string {
  return `Reset everyone to ${PRESET_LABEL[preset]}`;
}

/** A settings card's groups as lines: "Hiring: Can now … . Can no longer …." */
export function settingsLines(p: Pick<SettingsProposal, 'groups'>): string[] {
  return p.groups.map((g) => `${g.who}: ${g.changes.join('. ')}.`);
}
