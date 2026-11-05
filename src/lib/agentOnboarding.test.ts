/**
 * Tests for the agent-led onboarding library: guided prompt construction,
 * agent spawn mapping, and completion helpers. The prompt is the contract
 * between the app and the agent doing the setup work — regressions here turn
 * into an agent improvising installs on a stranger's machine.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { SetupItem } from './setup';

// Pin the platform: the prompt embeds per-OS commands and CI runs on
// different hosts. macOS is asserted here; the Windows variant is covered by
// the win-specific test below via the mocked switch.
const isWindowsMock = vi.hoisted(() => vi.fn(() => false));
vi.mock('./setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./setup')>();
  return { ...actual, isWindows: isWindowsMock };
});

const agentsMock = vi.hoisted(() => ({
  getAgentsOverview: vi.fn(),
  updateAgent: vi.fn(),
}));
vi.mock('./agents', () => agentsMock);

import {
  putChiefOnEngine,
  PROJECT_TOOL_ITEM_IDS,
  buildGuidedSetupPrompt as buildPrompt,
  getMissingOptionalTools,
  getMissingProjectTools,
  getMissingRequiredTools,
  projectToolIds,
  guidedAgentSpawn,
  areProjectToolsReady,
  isEnginePairReady,
  readyAgentsEngine,
} from './agentOnboarding';

function item(id: string, status: SetupItem['status']): SetupItem {
  return { id, friendlyName: id, status };
}

/** A run that includes GitHub, as most of these tests exercise. */
const WITH_GITHUB = ['homebrew', 'node', 'git', 'gh', 'gh_auth'];
const buildGuidedSetupPrompt = (
  missing: SetupItem[],
  ready: SetupItem[] = [],
  ids: readonly string[] = WITH_GITHUB
) => buildPrompt(missing, ready, ids);

const FRESH_MISSING: SetupItem[] = [
  item('homebrew', 'not_installed'),
  item('node', 'not_installed'),
  item('git', 'not_installed'),
  item('gh', 'not_installed'),
  item('gh_auth', 'not_installed'),
];

describe('buildGuidedSetupPrompt', () => {
  it('is a single line — newlines break Windows cmd.exe-wrapped spawns', () => {
    const prompt = buildGuidedSetupPrompt(FRESH_MISSING);
    expect(prompt).not.toContain('\n');
  });

  it('includes exact canonical commands for every missing macOS item', () => {
    isWindowsMock.mockReturnValue(false);
    const prompt = buildGuidedSetupPrompt(FRESH_MISSING);
    expect(prompt).toContain(
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    );
    expect(prompt).toContain('brew install node');
    expect(prompt).toContain('gh auth login --web --git-protocol https');
  });

  it('uses winget commands on Windows', () => {
    isWindowsMock.mockReturnValue(true);
    const prompt = buildGuidedSetupPrompt(FRESH_MISSING);
    expect(prompt).toContain('winget install --id OpenJS.NodeJS.LTS');
    expect(prompt).toContain('winget install --id Git.Git');
    expect(prompt).toContain('winget install --id GitHub.cli');
    expect(prompt).not.toContain('brew install');
    isWindowsMock.mockReturnValue(false);
  });

  it('tells the agent to check everything itself before installing', () => {
    const prompt = buildGuidedSetupPrompt([item('gh_auth', 'not_authenticated')]);
    expect(prompt).toContain('checking what is already installed yourself');
    expect(prompt).toContain('`brew --version`');
    expect(prompt).toContain('`gh auth status`');
    // Full command list always ships, even for items we detected as ready —
    // the agent's own checks are the source of truth, not ours.
    expect(prompt).toContain('brew install');
    expect(prompt).toContain('Skip any step whose tool already works');
  });

  it('includes our detection only as an overridable hint', () => {
    const prompt = buildGuidedSetupPrompt(
      [item('gh_auth', 'not_authenticated')],
      [item('git', 'ready'), item('node', 'ready')]
    );
    expect(prompt).toContain('detection currently reports installed: Git, Node.js');
    expect(prompt).toContain('missing: a GitHub sign-in');
    expect(prompt).toContain('trust what your checks find over this list');
  });

  it('numbers steps in install order', () => {
    const prompt = buildGuidedSetupPrompt(FRESH_MISSING);
    const homebrewPos = prompt.indexOf('1) Homebrew');
    const ghAuthPos = prompt.indexOf('5) GitHub sign-in');
    expect(homebrewPos).toBeGreaterThan(-1);
    expect(ghAuthPos).toBeGreaterThan(homebrewPos);
  });

  it('tells the agent verification is the app’s job, not its own claim', () => {
    const prompt = buildGuidedSetupPrompt(FRESH_MISSING);
    expect(prompt).toContain('a clean exit is a claim, not proof');
    expect(prompt).toContain('the app runs its own checks');
  });

  it('leaves GitHub out of a run that doesn’t include it', () => {
    const prompt = buildPrompt(FRESH_MISSING, [], ['homebrew', 'node', 'git']);
    expect(prompt).toContain('brew install node');
    expect(prompt).not.toContain('gh auth');
    expect(prompt).not.toContain('GitHub CLI');
  });

  it('verifies everything even when detection says nothing is missing', () => {
    const prompt = buildGuidedSetupPrompt([]);
    expect(prompt).toContain('checking what is already installed yourself');
    expect(prompt).toContain('detection reports everything already installed');
    expect(prompt).toContain('brew install');
    expect(prompt).not.toContain('\n');
  });

  it('licenses the agent to fix underlying problems, not just run the script', () => {
    const prompt = buildGuidedSetupPrompt(FRESH_MISSING);
    expect(prompt).toContain('no matter what this machine throws at you');
    expect(prompt).toContain('Xcode Command Line Tools');
    expect(prompt).toContain('Do not set up anything unrelated');
  });
});

describe('guidedAgentSpawn', () => {
  it('passes the prompt as a positional arg for claude, codex and cursor', () => {
    expect(guidedAgentSpawn('claude', 'PROMPT')).toEqual({ command: 'claude', args: ['PROMPT'] });
    expect(guidedAgentSpawn('codex', 'PROMPT')).toEqual({ command: 'codex', args: ['PROMPT'] });
    expect(guidedAgentSpawn('cursor', 'PROMPT')).toEqual({
      command: 'cursor-agent',
      args: ['PROMPT'],
    });
  });

  it('uses --prompt for opencode, whose positional is a project directory', () => {
    expect(guidedAgentSpawn('opencode', 'PROMPT')).toEqual({
      command: 'opencode',
      args: ['--prompt', 'PROMPT'],
    });
  });
});

describe('getMissingProjectTools', () => {
  it('returns required items that are present and not ready, in install order', () => {
    const items = [
      item('gh_auth', 'not_authenticated'),
      item('homebrew', 'not_installed'),
      item('node', 'ready'),
      item('claude', 'not_installed'), // agent items are not "required" here
    ];
    expect(getMissingProjectTools(items).map((i) => i.id)).toEqual(['homebrew', 'gh_auth']);
  });

  it('treats absent items as ready (npm_fix disappears once fixed)', () => {
    const items = PROJECT_TOOL_ITEM_IDS.filter((id) => id !== 'npm_fix').map((id) =>
      item(id, 'ready')
    );
    expect(getMissingProjectTools(items)).toEqual([]);
  });
});

describe('required and optional project tools', () => {
  it('requires only Node and Git; GitHub is optional', () => {
    const items = [
      item('homebrew', 'ready'),
      item('node', 'ready'),
      item('git', 'ready'),
      item('gh', 'not_installed'),
      item('gh_auth', 'not_installed'),
    ];
    expect(getMissingRequiredTools(items)).toEqual([]);
    expect(getMissingOptionalTools(items).map((i) => i.id)).toEqual(['gh', 'gh_auth']);
  });

  it('asks for the package manager only while it has something to install', () => {
    const toolsHere = [
      item('homebrew', 'not_installed'),
      item('node', 'ready'),
      item('git', 'ready'),
    ];
    expect(getMissingRequiredTools(toolsHere)).toEqual([]);
    const noNode = [
      item('homebrew', 'not_installed'),
      item('node', 'not_installed'),
      item('git', 'ready'),
    ];
    expect(getMissingRequiredTools(noNode).map((i) => i.id)).toEqual(['homebrew', 'node']);
    // GitHub's CLI is installed with it too, when GitHub is asked for.
    expect(projectToolIds([...toolsHere, item('gh', 'not_installed')], true)).toEqual([
      'homebrew',
      'node',
      'git',
      'gh',
    ]);
  });
});

describe('areProjectToolsReady', () => {
  const allRequiredReady = PROJECT_TOOL_ITEM_IDS.filter((id) => id !== 'npm_fix').map((id) =>
    item(id, 'ready')
  );

  it('requires the chosen agent pair on top of the required items', () => {
    expect(areProjectToolsReady(allRequiredReady, 'claude')).toBe(false);
    const withPair = [...allRequiredReady, item('claude', 'ready'), item('claude_auth', 'ready')];
    expect(areProjectToolsReady(withPair, 'claude')).toBe(true);
  });

  it('checks GitHub only in a run that includes it', () => {
    const items = [
      ...allRequiredReady.filter((i) => i.id !== 'gh_auth'),
      item('gh_auth', 'not_authenticated'),
      item('claude', 'ready'),
      item('claude_auth', 'ready'),
    ];
    expect(areProjectToolsReady(items, 'claude')).toBe(true);
    expect(areProjectToolsReady(items, 'claude', projectToolIds(items, true))).toBe(false);
  });

  it('fails when a required item is not ready, even with the agent ready', () => {
    const items = [
      ...allRequiredReady.filter((i) => i.id !== 'git'),
      item('git', 'not_installed'),
      item('claude', 'ready'),
      item('claude_auth', 'ready'),
    ];
    expect(areProjectToolsReady(items, 'claude')).toBe(false);
  });

  it('only checks the chosen agent, not every agent', () => {
    const items = [
      ...allRequiredReady,
      item('claude', 'ready'),
      item('claude_auth', 'ready'),
      item('codex', 'not_installed'),
    ];
    expect(areProjectToolsReady(items, 'claude')).toBe(true);
    expect(areProjectToolsReady(items, 'codex')).toBe(false);
  });

  it('null agent ("Other") gates on the tools only', () => {
    expect(areProjectToolsReady(allRequiredReady, null)).toBe(true);
    const items = [
      ...allRequiredReady.filter((i) => i.id !== 'node'),
      item('node', 'not_installed'),
    ];
    expect(areProjectToolsReady(items, null)).toBe(false);
  });
});

describe('engines onboarding offers', () => {
  it('counts an engine only when installed and signed in, by the app’s checks', () => {
    expect(isEnginePairReady([item('codex', 'ready')], 'codex')).toBe(false);
    expect(isEnginePairReady([item('codex', 'ready'), item('codex_auth', 'ready')], 'codex')).toBe(
      true
    );
  });

  it('finds a ready engine Agents can run on, and ignores the others', () => {
    const cursorOnly = [item('cursor', 'ready'), item('cursor_auth', 'ready')];
    expect(readyAgentsEngine(cursorOnly)).toBeNull();
    const codex = [...cursorOnly, item('codex', 'ready'), item('codex_auth', 'ready')];
    expect(readyAgentsEngine(codex)).toBe('codex');
  });

  it('needs no project tools: an engine alone is a finished setup', () => {
    const items = [...FRESH_MISSING, item('claude', 'ready'), item('claude_auth', 'ready')];
    expect(readyAgentsEngine(items)).toBe('claude');
    expect(areProjectToolsReady(items, 'claude')).toBe(false);
  });
});

describe('putChiefOnEngine', () => {
  const chief = (over: Record<string, unknown> = {}) => ({
    id: 'chief',
    isMain: true,
    engine: 'claude',
    sessionId: null,
    ...over,
  });

  beforeEach(() => {
    agentsMock.getAgentsOverview.mockReset();
    agentsMock.updateAgent.mockReset().mockResolvedValue(undefined);
  });

  it('moves a Chief that has never run onto Codex when Codex was set up', async () => {
    agentsMock.getAgentsOverview.mockResolvedValue({ agents: [chief()] });
    await putChiefOnEngine('codex');
    expect(agentsMock.updateAgent).toHaveBeenCalledWith('chief', { engine: 'codex' });
  });

  it('leaves a Chief that has a conversation on its engine', async () => {
    agentsMock.getAgentsOverview.mockResolvedValue({ agents: [chief({ sessionId: 's1' })] });
    await putChiefOnEngine('codex');
    expect(agentsMock.updateAgent).not.toHaveBeenCalled();
  });

  it('does nothing for Claude Code, the Chief’s default', async () => {
    await putChiefOnEngine('claude-code');
    expect(agentsMock.getAgentsOverview).not.toHaveBeenCalled();
  });

  it('swallows a failure: the chat offers the switch too', async () => {
    agentsMock.getAgentsOverview.mockRejectedValue(new Error('boom'));
    await expect(putChiefOnEngine('codex')).resolves.toBeUndefined();
  });
});
