/**
 * The desktop's list rules, so the phone orders and labels agents exactly as
 * the Agents view does. Copied from src/lib/agents.ts and
 * src/components/agents/AgentAvatar.tsx; they are pure and belong in
 * @shipstudio/companion-protocol next to the quote helpers (P2 moves them).
 */

import type {
  Agent,
  AgentMessage,
  Approval,
  EngineInfo,
  Failure,
  PermissionScope,
  SessionMark,
  UsageTotals,
} from '@shipstudio/companion-protocol';
import { diffLineKind } from './diff';

/** Pinned first, then most recently active. */
export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActivityAt - a.lastActivityAt;
  });
}

/** Waiting on you: mid-turn on a card, or paused with one still open. */
export const needsYou = (agent: Agent) =>
  agent.status.state === 'waiting' || (agent.pendingApprovals ?? 0) > 0;

/** Its last turn failed, and nothing has been said since. */
export const failedTurn = (agent: Agent): Failure | null =>
  agent.failure && agent.status.state === 'idle' ? agent.failure : null;

export const needsAttention = (agent: Agent) => needsYou(agent) || failedTurn(agent) !== null;

export function failureLine(failure: Failure, preview: string | null): string {
  if (failure.kind === 'usage_limit') {
    return failure.resetsAt
      ? `Usage limit · resets ${formatClock(failure.resetsAt)}`
      : 'Usage limit reached';
  }
  if (failure.kind === 'signed_out') return 'Claude Code is signed out';
  const clause = (preview ?? '').split(/(?<=[.!?:])\s/)[0].replace(/[.:]$/, '');
  return clause ? `Didn’t finish: ${clause}` : 'Didn’t finish';
}

/**
 * Queued behind the Mac's cap on concurrent turns: working, but its turn
 * hasn't started (no `since`). The desk's rule, from AgentChat's status label.
 */
export const waitingForSlot = (agent: Agent) =>
  agent.status.state === 'working' && agent.status.since == null;

/**
 * What a working agent is doing, or that it's waiting its turn: the Mac's
 * own words ("Waiting for a free slot (4 agents already working)"), or, where
 * a line is short (`brief`), the desk's label.
 */
export function workingLine(agent: Agent, brief = false): string {
  if (waitingForSlot(agent)) {
    return brief || !agent.status.activity ? 'Waiting for a free slot' : agent.status.activity;
  }
  return agent.status.activity ?? 'Working…';
}

/** "Claude Code" / "Codex": what the agent's turns run on. */
export const engineName = (agent: Agent) => (agent.engine === 'codex' ? 'Codex' : 'Claude Code');

/** Its model as its engine names it ("Opus"), or Default. */
export function modelName(agent: Agent, engines: EngineInfo[] | undefined): string {
  if (!agent.model) return 'Default';
  const listed = engines?.find((e) => e.id === agent.engine)?.models;
  return listed?.find((m) => m.value === agent.model)?.label ?? agent.model;
}

/**
 * "Claude · Opus", "Codex · Default". Null from a Mac too old to say which
 * engine, rather than guessing Claude.
 */
export function engineLine(agent: Agent, engines: EngineInfo[] | undefined): string | null {
  if (!agent.engine) return null;
  return `${agent.engine === 'codex' ? 'Codex' : 'Claude'} · ${modelName(agent, engines)}`;
}

/**
 * When the agent's engine can't stop to ask, anything that would need your
 * OK is refused instead, and nothing on the phone would otherwise say so.
 * Null when it can ask, or when the Mac doesn't say. Copied from
 * `engineCantAsk` in src/lib/agents.ts.
 */
export function engineCantAsk(agent: Agent, engines: EngineInfo[] | undefined): string | null {
  const info = engines?.find((e) => e.id === agent.engine);
  if (!info?.installed || info.asks !== false) return null;
  return `${info.label} can't stop to ask you here, so anything that needs your OK is refused. Updating ${info.label} fixes this.`;
}

/** The row's second line, as the sidebar writes it. */
export function subtitle(agent: Agent): string {
  if (agent.takeover) return DRIVEN_LINE;
  if (needsYou(agent)) return 'Needs your OK';
  if (agent.status.state === 'working') return workingLine(agent);
  const failure = failedTurn(agent);
  if (failure) return failureLine(failure, agent.preview);
  return agent.preview ?? agent.role ?? '';
}

export type LineState = 'waiting' | 'working' | 'failed' | 'limited' | undefined;

export function lineState(agent: Agent): LineState {
  if (agent.takeover) return 'working';
  if (needsYou(agent)) return 'waiting';
  if (agent.status.state === 'working') return 'working';
  const failure = failedTurn(agent);
  if (failure) return failure.kind === 'usage_limit' ? 'limited' : 'failed';
  return undefined;
}

/** A message of yours sent after the turn in progress began: queued for the next one. */
export function isQueued(message: Pick<AgentMessage, 'kind' | 'ts'>, agent: Agent): boolean {
  if (message.kind !== 'user') return false;
  // Driven on the Mac: what you send waits for the hand-back.
  if (agent.takeover) return message.ts > agent.takeover.since;
  const { state, since } = agent.status;
  return state !== 'idle' && since != null && message.ts > since;
}

/**
 * Someone is driving the agent's session by hand in a terminal on the Mac
 * (desktop "Take over"). The phone shows it; taking over is the Mac's.
 */
export const DRIVEN_LINE = 'Being driven on your Mac';

/** The composer's line while it's driven on the Mac: the same words as the row. */
export function drivenHint(): string {
  return `${DRIVEN_LINE} · what you send waits`;
}

/** "Chief of Staff" → "CS", "Agent 3" → "A3", "Finance" → "FI". */
export function agentInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter(
      (w) => /[A-Za-z0-9]/.test(w) && !['of', 'the', 'and', 'for', '&'].includes(w.toLowerCase())
    );
  const number = words.length >= 2 ? words[words.length - 1] : '';
  if (/^\d+$/.test(number)) {
    return number.length >= 2 ? number.slice(-2) : (words[0][0] + number).toUpperCase();
  }
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name.trim();
  return word.slice(0, 2).toUpperCase();
}

function consonantInitials(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  const next = letters.slice(1).match(/[b-df-hj-np-tv-z0-9]/i)?.[0] ?? letters[1] ?? '';
  return (letters[0] + next).toUpperCase();
}

/** Initials that don't collide with an agent listed before this one. */
export function distinctInitials(name: string, names: string[]): string {
  const own = agentInitials(name);
  const index = names.indexOf(name);
  const earlier = index === -1 ? names : names.slice(0, index);
  return earlier.some((n) => n !== name && agentInitials(n) === own)
    ? consonantInitials(name)
    : own;
}

/** Visible agents' names in creation order, Chief first: what `distinctInitials` compares. */
export const teamNames = (agents: Agent[]) =>
  agents
    .filter((a) => !a.hidden)
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || a.createdAt - b.createdAt)
    .map((a) => a.name);

/**
 * What "Always allow" will stop asking about, in a sentence. `revocable`:
 * end by saying where it can be taken back (not needed beside Revoke itself).
 */
export function describeScope(scope: PermissionScope, agentName: string, revocable = true): string {
  const what =
    scope.kind === 'command_prefix'
      ? `Any command starting with “${scope.label}”`
      : scope.kind === 'command'
        ? `Exactly “${scope.label}”`
        : scope.kind === 'domain'
          ? `Opening pages on ${scope.label}`
          : `“${scope.label}”`;
  const chained = scope.kind.startsWith('command')
    ? ' Commands chained with &&, ; or | still ask.'
    : '';
  const revoke = revocable ? ` Revoke it any time from ${agentName}’s sheet.` : '';
  return `${what} runs for ${agentName} without asking.${chained}${revoke}`;
}

const tokenCount = (t: UsageTotals) => {
  const n = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;
};

/** Turns, tokens and cost, as the Mac counts them. Cost only for the turns it could price. */
export function usageLine(t: UsageTotals): string {
  if (!t.turns) return 'Nothing yet';
  const cost =
    t.pricedTurns > 0
      ? `$${t.costUsd.toFixed(2)}${t.pricedTurns < t.turns ? ` for ${t.pricedTurns} of them` : ''}`
      : null;
  return [`${t.turns} turn${t.turns === 1 ? '' : 's'}`, `${tokenCount(t)} tokens`, cost]
    .filter(Boolean)
    .join(' · ');
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const CLI_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'Opencode',
};

/** "Claude Code 1": the tab as the project's tab bar names it. */
export function sessionLabel(mark: SessionMark): string {
  const cli = (mark.cli && CLI_NAMES[mark.cli]) ?? mark.cli ?? 'Session';
  return mark.tab ? `${cli} ${mark.tab}` : cli;
}

/** A project path's last folder: what the desktop calls a project with no name. */
export const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path;

/** "just now", "4 min ago", "2 h ago", or a date. */
export function formatAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** An agent's approval still waiting, as far as this phone's copy of its chat shows. */
export function pendingApproval(messages: AgentMessage[] | undefined): AgentMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'approval' && messages[i].approval?.status === 'pending') {
      return messages[i];
    }
  }
  return undefined;
}

/**
 * The row's second line for an agent waiting on you: what it's asking, when
 * the saved chat says; only "Needs your OK" when it doesn't.
 */
export function needsLine(agent: Agent, messages: AgentMessage[] | undefined): string {
  const asking = pendingApproval(messages)?.approval;
  return asking ? `Needs your OK · ${askingLine(asking)}` : subtitle(agent);
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** What a package manager's subcommand does, or null for one this doesn't know. */
function packageVerb(args: string[]): string | null {
  const [sub, script] = args;
  if (!sub || ['install', 'i', 'add', 'ci'].includes(sub)) return 'install packages';
  if (['remove', 'uninstall', 'rm', 'un'].includes(sub)) return 'remove packages';
  if (sub === 'test' || sub === 't') return 'run the tests';
  if (sub === 'run' && script) return `run its “${script}” script`;
  if (['exec', 'dlx', 'x'].includes(sub)) return script ? `run ${script}` : null;
  return `run its “${sub}” script`;
}

const GIT: Record<string, string> = {
  push: 'push commits',
  commit: 'commit changes',
  pull: 'pull the latest changes',
  fetch: 'fetch the latest changes',
  clone: 'download a repository',
  checkout: 'switch branches',
  switch: 'switch branches',
  merge: 'merge branches',
  rebase: 'rebase a branch',
  reset: 'reset changes',
  stash: 'set changes aside',
  add: 'stage changes',
};

const PROGRAMS: Record<string, string> = {
  cp: 'copy files',
  mv: 'move files',
  rm: 'delete files',
  rmdir: 'delete a folder',
  mkdir: 'create a folder',
  touch: 'create a file',
  cat: 'read a file',
  head: 'read a file',
  tail: 'read a file',
  ls: 'look through files',
  find: 'look through files',
  grep: 'search files',
  rg: 'search files',
  curl: 'fetch something from the web',
  wget: 'download something from the web',
  chmod: 'change file permissions',
  chown: 'change file ownership',
  kill: 'stop a process',
  pkill: 'stop a process',
  open: 'open something on your Mac',
  node: 'run a script',
  python: 'run a script',
  python3: 'run a script',
  tsx: 'run a script',
  deno: 'run a script',
};

/**
 * A shell command as a person would say it: "Wants to copy files", "Wants to
 * run the tests". Only a preview: the card shows the command itself, and a
 * chain says there's more to it rather than naming only its harmless start.
 */
export function commandLine(command: string): string {
  const steps = command
    .split(/&&|\|\||;|\||\n/)
    .map((step) => step.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0)
    // Moving into a folder first isn't what it's asking to do.
    .filter((words, i, all) => !(words[0] === 'cd' && i < all.length - 1));
  const first = steps[0];
  if (!first) return 'Wants to run a command';
  let words = first;
  while (words.length > 1 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === 'sudo'))
    words = words.slice(1);
  const program = words[0].split('/').pop() ?? words[0];
  const args = words.slice(1).filter((w) => !w.startsWith('-'));
  const verb =
    program === 'git'
      ? (GIT[args[0]] ?? 'use git')
      : PACKAGE_MANAGERS.has(program)
        ? packageVerb(args)
        : program === 'npx' || program === 'bunx'
          ? args[0]
            ? `run ${args[0]}`
            : null
          : (PROGRAMS[program] ?? null);
  const line = `Wants to ${verb ?? `run “${program}”`}`;
  return steps.length > 1 ? `${line}, and more` : line;
}

/**
 * What an approval asks, in a line a person reads: a command in plain words
 * (`commandLine`), never a diff's `@@ -18,3 +18,3 @@` or a file header. An
 * edit says which file ("Wants to edit Header.tsx").
 */
export function askingLine(approval: Pick<Approval, 'title' | 'detail' | 'tool'>): string {
  if (approval.title === 'Run a command' && approval.detail?.trim())
    return commandLine(approval.detail);
  // A command whose title already says it in words: the title, never the command.
  if (approval.tool === 'Bash') return approval.title;
  const lines = (approval.detail ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const diff = lines.some((l) => diffLineKind(l) !== 'context' || /^(\+\+\+|---)\s/.test(l));
  if (!diff && lines[0]) return lines[0];
  const edit = /^do you want to make this edit to (.+?)\?*$/i.exec(approval.title.trim());
  if (edit) return `Wants to edit ${edit[1]}`;
  return approval.title;
}

/** "2 need you · 3 working", over the agents shown on Home. */
export function attentionCounts(agents: Agent[]) {
  const shown = agents.filter((a) => !a.hidden);
  return {
    needYou: shown.filter(needsYou).length,
    // As the desk's tray counts: one waiting for a slot is listed, not working.
    working: shown.filter((a) => !needsYou(a) && a.status.state === 'working' && !waitingForSlot(a))
      .length,
  };
}

/**
 * The next thing waiting on you, in Home's order: the agent and, when the
 * saved chat has it, the approval to open at.
 */
export function nextNeedsYou(
  agents: Agent[],
  chats: Record<string, { messages: AgentMessage[] } | undefined>
): { agentId: string; messageId?: string } | null {
  const next = sortAgents(agents.filter((a) => !a.hidden)).find(needsYou);
  if (!next) return null;
  const card = pendingApproval(chats[next.id]?.messages);
  return { agentId: next.id, ...(card ? { messageId: card.id } : {}) };
}

const OUTCOME = {
  allowed: 'Allowed',
  denied: 'Declined',
  expired: 'Not answered in time',
  pending: '',
} as const;

/** An answered card in a line, as the desk words it (with the option picked on a session's question). */
export function cardOutcome(approval: Approval): string {
  if (approval.alwaysAllowed && approval.always) return `Always allowed · ${approval.always.label}`;
  if (approval.status === 'denied' && approval.note) return `Declined · “${approval.note}”`;
  const label = OUTCOME[approval.status];
  if (approval.choice && approval.status !== 'expired') return `${label} · ${approval.choice}`;
  return label;
}

/** Whether its next message would continue a conversation (one there is to leave). */
export const canStartFresh = (agent: Pick<Agent, 'sessionId' | 'newEngine'>) =>
  Boolean(agent.sessionId || agent.newEngine);

/** From this full, the agent sheet suggests starting fresh. Matches the desk. */
export const CONTEXT_SUGGEST_AT = 85;

/** How full its conversation is, 0-100, or null when its engine didn't say. */
export function contextPercent(agent: Pick<Agent, 'context'>): number | null {
  const fill = agent.context;
  if (!fill || fill.window <= 0) return null;
  return Math.min(100, Math.round((fill.used / fill.window) * 100));
}

/** "72% full", from its engine's own numbers; null when it didn't report them. */
export function contextLine(agent: Pick<Agent, 'context'>): string | null {
  const percent = contextPercent(agent);
  return percent === null ? null : `${percent < 1 ? '<1' : percent}% full`;
}
