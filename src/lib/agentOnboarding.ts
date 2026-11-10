/**
 * Agent-led setup: the agent does the setup work, the app verifies it.
 *
 * Onboarding needs exactly one thing: an engine that can run Agents (Claude
 * Code or Codex) installed and signed in. That is the only part that can't
 * be agent-led, and it is all a person needs to start talking to their Chief
 * of Staff.
 *
 * Project tools (Homebrew/winget, Node, Git, GitHub CLI, GitHub sign-in) are
 * asked for later, the first time work becomes a project
 * (`ProjectToolsModal`): the agent is spawned in a terminal with a
 * prescriptive prompt and installs them while a checklist polls
 * `get_full_setup_status` — the backend's real checks, never the agent's own
 * claims, decide when it is done.
 *
 * @module lib/agentOnboarding
 */

import { agentPromptArgs } from './agent';
import { invoke } from '@tauri-apps/api/core';
import { SetupItem, isSetupItemReady, isWindows, TerminalCommand } from './setup';
import { getAgentsOverview, updateAgent } from './agents';
import { logger } from './logger';

// ============ Engines ============

/**
 * The setup ids of the engines Agents runs on (`agents::engine`). Onboarding
 * offers only these: an agent CLI that can't run Agents would finish setup
 * into a product that can't start.
 */
export const AGENTS_ENGINE_BINARY_IDS = ['claude', 'codex', 'opencode'] as const;
export type AgentsEngineBinaryId = (typeof AGENTS_ENGINE_BINARY_IDS)[number];

/** Installed and signed in, by the app's own checks. */
export function isEnginePairReady(items: SetupItem[], binaryId: string): boolean {
  return (
    items.find((i) => i.id === binaryId)?.status === 'ready' &&
    items.find((i) => i.id === `${binaryId}_auth`)?.status === 'ready'
  );
}

/** The first engine that can run Agents and is ready, if any. */
export function readyAgentsEngine(items: SetupItem[]): AgentsEngineBinaryId | null {
  return AGENTS_ENGINE_BINARY_IDS.find((id) => isEnginePairReady(items, id)) ?? null;
}

/**
 * Put a Chief of Staff that has never run onto the engine onboarding just
 * set up. The Chief defaults to Claude Code; someone who set up only Codex
 * (or OpenCode) would otherwise land on a Chief that can't answer. A Chief
 * that has run keeps its engine. Failure is logged: the chat offers the
 * engine switch too.
 */
export async function putChiefOnEngine(defaultAgentId: string | null): Promise<void> {
  if (defaultAgentId !== 'codex' && defaultAgentId !== 'opencode') return;
  const engine = defaultAgentId;
  try {
    const { agents } = await getAgentsOverview();
    const chief = agents.find((a) => a.isMain);
    if (chief && chief.engine !== engine && !chief.sessionId) {
      await updateAgent(chief.id, { engine });
    }
  } catch (err) {
    logger.warn(`Could not move the Chief of Staff onto ${engine}`, { error: String(err) });
  }
}

// ============ Test-mode API ============

/** How the app was launched, for swapping real side effects in test modes. */
export interface OnboardingTestMode {
  /** `SHIPSTUDIO_FORCE_SETUP` is set — statuses are mocked; run the scripted demo. */
  mock: boolean;
  /** `SHIPSTUDIO_FORCE_ONBOARDING` is set — real checks, wizard forced open. */
  forceOnboarding: boolean;
  /**
   * `SHIPSTUDIO_FORCE_INSTALL_FAILURE` (mock mode only): the first mock run
   * of each item that can fail this way does (`network`, `disk`,
   * `permission`, `admin`, `homebrew`, `signin`; `lib/installProgress`).
   */
  mockFailure?: string | null;
}

export async function getOnboardingTestMode(): Promise<OnboardingTestMode> {
  return invoke<OnboardingTestMode>('get_onboarding_test_mode');
}

/**
 * Flip one item to ready in the backend's mock state (mock mode only).
 * The demo agent session calls this on a timeline so the checklist UI is
 * exercised end-to-end without touching the host machine.
 */
export async function mockMarkSetupItemReady(itemId: string): Promise<void> {
  return invoke('mock_mark_setup_item_ready', { itemId });
}

/**
 * Directory the guided agent session runs in — the projects root
 * (~/ShipStudio), created if missing. Never the user's home: an agent
 * scanning $HOME trips macOS permission prompts (Photos, Desktop, Documents)
 * attributed to this app, and the pending dialog freezes the agent
 * mid-scan.
 */
export async function ensureAgentWorkdir(): Promise<string> {
  return invoke<string>('ensure_agent_workdir');
}

// ============ Project tools & completion ============

/**
 * What a project can need on the machine, in install order. None of it gates
 * onboarding; it is asked for when work first becomes a project. Only Node
 * and Git are required (and the package manager while it's needed to install
 * something). GitHub is offered, never required: projects work without it,
 * and it's only where they're backed up and reviewed. Hosting stays optional
 * (connectable later from a project's Push popover).
 */
export const PROJECT_TOOL_ITEM_IDS = [
  'homebrew',
  'node',
  'npm_fix',
  'git',
  'gh',
  'gh_auth',
] as const;

/** Offered alongside, never required. */
export const OPTIONAL_PROJECT_TOOL_IDS: readonly string[] = ['gh', 'gh_auth'];

/** Installed with the package manager (npm_fix and the sign-in aren't). */
const NEEDS_INSTALLER = new Set(['node', 'git', 'gh']);

/**
 * The items a setup run covers and checks, in install order: Node, Git (and
 * the npm fix while ~/.npm is broken), GitHub when asked for, and the package
 * manager when one of those still has to be installed. Absent items (npm_fix
 * once permissions are fine) are left out.
 */
export function projectToolIds(items: SetupItem[], includeGitHub: boolean): string[] {
  const ids = PROJECT_TOOL_ITEM_IDS.filter(
    (id) => id !== 'homebrew' && (includeGitHub || !OPTIONAL_PROJECT_TOOL_IDS.includes(id))
  ).filter((id) => items.some((i) => i.id === id));
  const installs = ids.some((id) => NEEDS_INSTALLER.has(id) && !isSetupItemReady(items, id));
  const withInstaller = installs && items.some((i) => i.id === 'homebrew');
  return withInstaller ? ['homebrew', ...ids] : ids;
}

/** Of `ids`, the items present in the status and not yet ready. */
export function getMissingProjectTools(
  items: SetupItem[],
  ids: readonly string[] = PROJECT_TOOL_ITEM_IDS
): SetupItem[] {
  return ids
    .map((id) => items.find((i) => i.id === id))
    .filter((item): item is SetupItem => item !== undefined && item.status !== 'ready');
}

/** What a project can't be made without and isn't here yet. */
export function getMissingRequiredTools(items: SetupItem[]): SetupItem[] {
  return getMissingProjectTools(items, projectToolIds(items, false));
}

/** GitHub, if it isn't set up: offered, never required. */
export function getMissingOptionalTools(items: SetupItem[]): SetupItem[] {
  return getMissingProjectTools(items, OPTIONAL_PROJECT_TOOL_IDS);
}

/** Of `ids`, the ones already ready — the prompt names these so the agent
 *  confirms them to the user instead of silently skipping them. */
export function getReadyProjectTools(
  items: SetupItem[],
  ids: readonly string[] = PROJECT_TOOL_ITEM_IDS
): SetupItem[] {
  return ids
    .map((id) => items.find((i) => i.id === id))
    .filter((item): item is SetupItem => item !== undefined && item.status === 'ready');
}

/**
 * The guided phase is done when every item it covers (`ids`) is ready AND the
 * agent running it is still installed and signed in. Computed from items (not
 * `allReady`, which only means "an engine is ready") so the checklist and the
 * Continue button agree.
 *
 * `agentBinaryId: null` means an agent we don't manage, so only the tools
 * gate completion.
 */
export function areProjectToolsReady(
  items: SetupItem[],
  agentBinaryId: string | null = null,
  ids: readonly string[] = projectToolIds(items, false)
): boolean {
  const requiredReady = ids.every((id) => isSetupItemReady(items, id));
  if (agentBinaryId === null) return requiredReady;
  return requiredReady && isEnginePairReady(items, agentBinaryId);
}

// ============ Guided prompt ============

/**
 * Per-item install instructions the agent is told to use, phrased as prompt
 * fragments. These mirror the classic wizard's canonical commands
 * (TERMINAL_COMMANDS / installPackages in lib/setup.ts) — the agent gets the
 * wizard's logic as instructions instead of code, so it doesn't improvise.
 */
function itemInstruction(itemId: string, win: boolean): string | null {
  switch (itemId) {
    case 'homebrew':
      return win
        ? 'the winget package manager: it ships with Windows via "App Installer" — check with `winget --version`, and if missing, tell the user to install "App Installer" from the Microsoft Store, then verify again'
        : 'Homebrew: run `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` — warn the user first that macOS will ask for their computer password and that nothing appears on screen while they type it';
    case 'node':
      return win
        ? 'Node.js: run `winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements`'
        : 'Node.js: run `brew install node` (batch it with git/gh into one `brew install` when those are also missing; if Homebrew was installed moments ago, run `eval "$(/opt/homebrew/bin/brew shellenv)"` first on Apple Silicon, or use /usr/local/bin/brew on Intel)';
    case 'npm_fix':
      return win
        ? 'fix npm cache permissions: run `icacls "$env:USERPROFILE\\.npm" /grant "$env:USERNAME:(OI)(CI)F" /T` in PowerShell'
        : 'fix npm cache permissions: run `sudo chown -R $(whoami) ~/.npm` (this needs the computer password again)';
    case 'git':
      return win
        ? 'Git: run `winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements`'
        : 'Git: run `brew install git`';
    case 'gh':
      return win
        ? 'GitHub CLI: run `winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements`'
        : 'GitHub CLI: run `brew install gh`';
    case 'gh_auth':
      return 'GitHub sign-in: run `gh auth login --web --git-protocol https` — tell the user a browser will open where they sign in or create a free GitHub account, and that they should come back here afterwards';
    default:
      return null;
  }
}

/** Friendly names for the prompt's "missing" summary. */
const PROMPT_ITEM_NAMES: Record<string, string> = {
  homebrew: 'a package manager',
  node: 'Node.js',
  npm_fix: 'working npm permissions',
  git: 'Git',
  gh: 'the GitHub CLI',
  gh_auth: 'a GitHub sign-in',
};

/**
 * Build the single-message setup prompt for the guided phase.
 *
 * Deliberately a single line: multi-line argv survives every PTY spawn shape
 * (including the Windows cmd.exe-wrapped .cmd shims) only if there are no
 * newlines to re-parse. Deliberately prescriptive: exact commands, verify
 * before moving on, plain language — the classic wizard rewritten as
 * instructions. The app's own checks decide completion, and the prompt says
 * so, so the agent doesn't overclaim.
 */
export function buildGuidedSetupPrompt(
  missing: SetupItem[],
  alreadyReady: SetupItem[] = [],
  ids: readonly string[] = ['homebrew', 'node', 'git']
): string {
  const win = isWindows();

  // The agent is the source of discovery: it gets the FULL list for this run
  // with check commands and verifies everything itself. Our detection rides
  // along only as a reference hint it can override — the app's probes and
  // the agent's terminal can see different PATHs, and the terminal is where
  // the work actually happens. npm_fix only exists while ~/.npm is broken, so
  // it joins only when our checks actually surfaced it.
  const requiredIds = ids.filter((id) => id !== 'npm_fix' || missing.some((i) => i.id === id));
  const instructions = requiredIds
    .map((id) => itemInstruction(id, win))
    .filter((s): s is string => s !== null);

  const CHECKS: Record<string, string> = {
    homebrew: win ? '`winget --version`' : '`brew --version`',
    node: '`node --version`',
    git: '`git --version`',
    gh: '`gh --version`',
    gh_auth: '`gh auth status`',
  };
  const checkCommands = requiredIds.map((id) => CHECKS[id]).filter(Boolean);

  missing = missing.filter((i) => ids.includes(i.id));
  alreadyReady = alreadyReady.filter((i) => ids.includes(i.id));
  const missingNames = missing.map((i) => PROMPT_ITEM_NAMES[i.id] ?? i.id).join(', ');
  const readyNames = alreadyReady.map((i) => PROMPT_ITEM_NAMES[i.id] ?? i.id).join(', ');
  const detectionHint =
    missingNames && readyNames
      ? `For reference, the app's own detection currently reports installed: ${readyNames}; missing: ${missingNames} — but trust what your checks find over this list. `
      : missingNames
        ? `For reference, the app's own detection currently reports everything missing: ${missingNames} — but trust what your checks find over this list. `
        : "For reference, the app's own detection reports everything already installed — but trust what your checks find over this list. ";

  const steps = instructions.map((s, idx) => `${String(idx + 1)}) ${s}`).join('; ');

  return (
    'You are helping someone get their computer ready for projects (sites and apps their agents build). ' +
    'They use a desktop app where a team of AI agents works for them, and you are one of those agents — be warm, brief, and clear. ' +
    'Assume the user is not technical: before each step, say what you are about to do in one short sentence. ' +
    `Start by checking what is already installed yourself: run ${checkCommands.join(', ')}, then give the user one short summary of what's already good and what's missing. ` +
    detectionHint +
    `Then set up ONLY what is actually missing, one at a time, in this order, using these exact commands as the standard path: ${steps}. ` +
    'Skip any step whose tool already works. ' +
    'When you are asked to approve a command permission, reassure the user it is safe to approve the commands listed above. ' +
    `After each install, verify it actually worked (run the tool with --version${requiredIds.includes('gh_auth') ? ', or `gh auth status` for the sign-in' : ''}) before moving on — a clean exit is a claim, not proof. ` +
    'Your job is to get every listed tool working no matter what this machine throws at you: if a standard command fails, read the error, explain it in plain words, and fix the underlying problem — installing prerequisites (like Xcode Command Line Tools), repairing PATH or npm permissions, or retrying another official install method are all fair game. ' +
    'If the user has to do something themselves (type a password, click through a browser), tell them exactly what to expect. ' +
    'Do not set up anything unrelated to the tools listed above. ' +
    'When everything is verified, tell the user they are all set and to look at the checklist beside this window — the app runs its own checks and will turn every item green, then show a Continue button.'
  );
}

// ============ Agent spawn mapping ============

/**
 * How to launch each agent CLI as an interactive session seeded with a
 * prompt. Verified against each CLI's --help: claude, codex and cursor-agent
 * take the initial prompt as a positional argument; opencode's positional is
 * a project directory, so it takes `--prompt` instead.
 */
export function guidedAgentSpawn(agentBinaryId: string, prompt: string): TerminalCommand {
  const binary = agentBinaryId === 'cursor' ? 'cursor-agent' : agentBinaryId;
  return { command: binary, args: agentPromptArgs(agentBinaryId, prompt) };
}

/**
 * Plain interactive shell for the "Other" path — the user launches whatever
 * agent CLI they use and pastes the guided prompt themselves.
 */
export function otherAgentShellSpawn(): TerminalCommand {
  return isWindows() ? { command: 'powershell', args: [] } : { command: '/bin/zsh', args: ['-il'] };
}
