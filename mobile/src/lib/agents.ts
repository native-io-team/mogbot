/**
 * The desktop's list rules, so the phone orders and labels agents exactly as
 * the Agents view does. Copied from src/lib/agents.ts and
 * src/components/agents/AgentKey.tsx; they are pure and belong in
 * @shipstudio/companion-protocol next to the quote helpers (P2 moves them).
 */

import type {
  Agent,
  AgentMessage,
  Approval,
  EngineInfo,
  KeyState,
  Failure,
  PermissionScope,
  TeamSetupView,
  UsageTotals,
} from '@shipstudio/companion-protocol';
import {
  apiPrice,
  keyStateOf,
  needsYouCount,
  secretTitle,
  skillOutcome,
  skillWhenLine,
  tokenCount,
  workingRowLine,
} from '@shipstudio/companion-protocol';
import {
  formatClock as clockOf,
  crossoverOutcome,
  failureLine as sharedFailureLine,
  failurePill,
  previewText,
  stepInOutcome,
} from '@shipstudio/companion-protocol';
import { drivenLine } from './bars';
import { diffLineKind } from './diff';
import { ENGINE_DEFAULT } from './newAgentDefaults';

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

/** Stopped by a usage limit: paused until it resets, not waiting on you. */
export const usageLimited = (agent: Agent) =>
  !needsYou(agent) && failedTurn(agent)?.kind === 'usage_limit';

/**
 * What its key shows (the desk's `agentKeyState`): Needs your OK when a card
 * waits, Paused while a usage limit stops it, Working while a turn runs,
 * Live while you drive its session at the desk (Take over).
 */
export function agentKeyState(
  agent: Agent,
  working = agent.status.state === 'working' && !agent.takeover
): KeyState {
  return keyStateOf({
    needsOk: needsYou(agent),
    paused: usageLimited(agent),
    working,
    live: Boolean(agent.takeover),
  });
}

/**
 * A failed turn in a line, as the desk says it (`failures.ts`): "Out of
 * usage until 3:00 PM", "Codex is signed out", "<reason> · didn't finish".
 */
export function failureLine(failure: Failure, preview: string | null, engine?: string): string {
  return sharedFailureLine(failure, preview, engine ?? 'Its AI app');
}

/**
 * A row's state as a pill and the words after it (the desk's `failurePill`):
 * the state in the pill ("Didn't finish", "Out of usage"), the reason as
 * plain text. Out of usage is neutral: it resets by itself.
 */
export function rowPill(
  agent: Agent,
  line: string
): { tone: 'waiting' | 'failed' | 'out'; label: string; rest: string } | null {
  const state = lineState(agent);
  if (state === 'waiting') {
    const cut = line.indexOf(' · ');
    return cut < 0
      ? { tone: 'waiting', label: line, rest: '' }
      : { tone: 'waiting', label: line.slice(0, cut), rest: line.slice(cut + 3) };
  }
  const failure = state === 'failed' || state === 'limited' ? failedTurn(agent) : null;
  if (!failure) return null;
  return failurePill(failure, previewText(agent.preview), engineName(agent));
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
    // The same words as the row's (`rowLine`): one state, one wording.
    return brief || !agent.status.activity
      ? 'Waiting for a free slot'
      : rowLine(agent.status.activity);
  }
  // Between calls the engine is deciding what's next: say that, not "Working…".
  return agent.status.activity ?? 'Thinking';
}

/** "Claude Code" / "Codex" / "OpenCode": what the agent's turns run on. */
export const engineName = (agent: Pick<Agent, 'engine'>) =>
  agent.engine === 'codex' ? 'Codex' : agent.engine === 'opencode' ? 'OpenCode' : 'Claude Code';

/** Its model as its engine names it ("Opus"), or "Default". */
export function modelName(agent: Agent, engines: EngineInfo[] | undefined): string {
  if (!agent.model) return ENGINE_DEFAULT;
  const listed = engines?.find((e) => e.id === agent.engine)?.models;
  return listed?.find((m) => m.value === agent.model)?.label ?? agent.model;
}

/**
 * "Claude · Opus", "Codex · Default". Null from a Mac too old to say which
 * engine, rather than guessing Claude.
 */
export function engineLine(agent: Agent, engines: EngineInfo[] | undefined): string | null {
  if (!agent.engine) return null;
  const engine =
    agent.engine === 'codex' ? 'Codex' : agent.engine === 'opencode' ? 'OpenCode' : 'Claude';
  return `${engine} · ${modelName(agent, engines)}`;
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

/** The same, as a bar's two lines. */
export function engineCantAskBar(
  agent: Agent,
  engines: EngineInfo[] | undefined
): { title: string; detail: string } | null {
  const info = engines?.find((e) => e.id === agent.engine);
  if (!engineCantAsk(agent, engines) || !info) return null;
  return {
    title: `${info.label} can’t stop to ask you here`,
    detail: `Anything that needs your OK is refused. Updating ${info.label} fixes this.`,
  };
}

/** The row's second line, as the sidebar writes it. */
export function subtitle(agent: Agent, now = Date.now()): string {
  // A request outranks driving, as on the desk: the row's words and its amber dot agree.
  if (needsYou(agent)) return 'Needs your OK';
  if (agent.takeover) return drivenLine(agent.name);
  if (agent.status.state === 'working') {
    if (waitingForSlot(agent)) return rowLine(workingLine(agent));
    // The live step and how long it's been at it: "Running the Cypress tests · 5m".
    const row = workingRowLine(agent.status.activity, agent.status.work, agent.status.since, now);
    return row.elapsed ? `${row.text} · ${row.elapsed}` : row.text;
  }
  const failure = failedTurn(agent);
  if (failure) return failureLine(failure, previewText(agent.preview), engineName(agent));
  return previewText(agent.preview) ?? '';
}

/** An agent's role for a list row: one line, no folder path in it. '' when it has none. */
export function roleLabel(role: string | undefined): string {
  const path = String.raw`(?:~|\/(?:Users|home|Volumes|private)\b)[^\s,;]*?(?=\.?(?:\s|$|[,;]))`;
  return (role ?? '')
    .replace(new RegExp(String.raw`\s+(?:in|at|from|under|inside)\s+` + path, 'g'), '')
    .replace(new RegExp(path, 'g'), '')
    .replace(/\s+([.,;])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A list row's one line, cut where it can be read: the Mac's "Waiting for a
 * free slot (4 agents already working)" would be clipped inside its
 * parenthesis, so it says "Waiting for a free slot · 4 others working", in
 * the row and in the chat alike.
 */
export function rowLine(line: string): string {
  const slot = /^(.*?)\s*\((\d+) agents? already working\)\s*$/.exec(line);
  if (!slot) return line;
  const n = Number(slot[2]);
  return `${slot[1]} · ${n} other${n === 1 ? '' : 's'} working`;
}

export type LineState = 'waiting' | 'working' | 'failed' | 'limited' | undefined;

export function lineState(agent: Agent): LineState {
  if (needsYou(agent)) return 'waiting';
  if (agent.takeover) return 'working';
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

/** "Chief of Staff" → "CS", "Agent 3" → "A3", "Finance" → "FI". */
export function agentInitials(name: string): string {
  // Only letters and digits make initials: "Finance (from Grok)" is
  // "Finance", never "F(". A trailing aside in brackets is dropped.
  const words = name
    .replace(/\s*[([{].*$/u, '')
    .trim()
    .split(/[^\p{L}\p{N}&]+/u)
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

/**
 * Messages it worked on and their cost, as the Mac counts them: in a
 * person's words, not turns. Cost only for the ones it could price, said as
 * a list price ("at API prices"); on a Claude plan (`onPlan`) that price
 * isn't the bill, so its tokens instead.
 */
export function usageLine(t: UsageTotals, onPlan = false): string {
  const checks = t.checks ?? 0;
  if (!t.turns && !checks) return 'Nothing yet';
  const units = t.turns + checks;
  const priced = t.pricedTurns + (t.pricedChecks ?? 0);
  const cost = onPlan
    ? tokenCount(t)
    : priced > 0
      ? `${apiPrice(t.costUsd)}${priced < units ? ` for ${priced} of them` : ''}`
      : null;
  return [
    t.turns ? `${t.turns} message${t.turns === 1 ? '' : 's'}` : null,
    // "When…" routines' checks: not messages, said apart.
    checks ? `${checks} check${checks === 1 ? '' : 's'}` : null,
    cost,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "9:00 AM" / "09:00", as the Mac shows times (companion-protocol `clock`). */
export const formatClock = (ts: number): string => clockOf(ts);

/**
 * A project's task, named by what it was asked: the first line of its
 * opening prompt (the `started` mark's text, or the first message sent to
 * it), trimmed; "Task started 6:28 AM" when only the start is known; "Task"
 * when nothing is. Never a tab number ("Task 1") or the engine ("Claude Code
 * 1"): neither says what it is, and "session" stays an internal name.
 */
export function taskName(
  sessionId: string | undefined,
  chats: Record<string, { messages: AgentMessage[] }>
): string {
  if (!sessionId) return 'Task';
  let started: AgentMessage | undefined;
  let firstSent: AgentMessage | undefined;
  for (const chat of Object.values(chats)) {
    for (const m of chat.messages) {
      const mark = m.session;
      if (mark?.sessionId !== sessionId) continue;
      if (mark.event === 'started' && (!started || m.ts < started.ts)) started = m;
      if (mark.event === 'sent' && m.text.trim() && (!firstSent || m.ts < firstSent.ts))
        firstSent = m;
    }
  }
  const asked = firstLine(started?.text) || firstLine(firstSent?.text);
  if (asked) return asked;
  return started ? `Task started ${formatClock(started.ts)}` : 'Task';
}

const TASK_NAME_MAX = 60;

/** A prompt's first line, cut at a word under 60 characters. */
function firstLine(text: string | undefined): string {
  const line = (text ?? '').trim().split('\n')[0].trim();
  if (line.length <= TASK_NAME_MAX) return line;
  const cut = line.slice(0, TASK_NAME_MAX);
  const gap = cut.lastIndexOf(' ');
  return `${(gap > 20 ? cut.slice(0, gap) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
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
  return formatDate(ts, now);
}

/**
 * The app's one way to write a date: "Nov 4", and "Nov 4, 2025" when it's
 * not this year. Everywhere a date is shown (paired, last seen, a chat's day).
 */
export function formatDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });
}

/**
 * Whether the phone can answer this card. An import's review card only on a
 * Mac that serves `agents.import.review` (`reviewHere`): there the phone's
 * card shows each agent's instructions and imports them as new agents; an
 * older Mac refuses an Allow sent from anywhere but its own card.
 */
export const answerableHere = (approval: Pick<Approval, 'connector'>, reviewHere = false) =>
  reviewHere || approval.connector?.kind !== 'review';

const pendingCard = (m: AgentMessage): Approval | null =>
  m.kind === 'approval' && m.approval?.status === 'pending' ? m.approval : null;

/** Every card still waiting that the phone can answer, oldest first (ids). */
export function pendingApprovalIds(messages: AgentMessage[] | undefined): string[] {
  if (!messages) return [];
  return messages
    .filter((m) => {
      const card = pendingCard(m);
      return !!card && answerableHere(card);
    })
    .map((m) => m.id);
}

/**
 * An agent's approval still waiting that the phone can answer, as far as
 * this phone's copy of its chat shows. A review card isn't one.
 */
export function pendingApproval(messages: AgentMessage[] | undefined): AgentMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const card = pendingCard(messages[i]);
    if (card && answerableHere(card)) return messages[i];
  }
  return undefined;
}

/**
 * Everything it's waiting on can only be answered on the Mac (an import to
 * review), as far as the saved chat shows. The Mac's `pendingApprovals`
 * counts review cards too; when it counts more than the chat holds, or the
 * agent is stopped mid-turn on a card, one of them may be answerable here,
 * so this says no rather than hide it.
 */
export function waitingOnMac(
  agent: Agent,
  messages: AgentMessage[] | undefined,
  reviewHere = false
): boolean {
  if (!messages || !needsYou(agent)) return false;
  let reviews = 0;
  for (const m of messages) {
    const card = pendingCard(m);
    if (!card) continue;
    if (answerableHere(card, reviewHere)) return false;
    reviews++;
  }
  return (
    reviews > 0 && agent.status.state !== 'waiting' && (agent.pendingApprovals ?? 0) <= reviews
  );
}

/** Waiting on an answer this phone can give: `needsYou`, less what only the Mac can answer. */
export const needsYouHere = (agent: Agent, messages: AgentMessage[] | undefined) =>
  needsYou(agent) && !waitingOnMac(agent, messages);

/** Said wherever "Needs your OK" would be, for a card only the Mac can answer. */
export const ON_MAC_LINE = 'Waiting for you on your Mac';

/**
 * The row's second line for an agent waiting on you: what it's asking, when
 * the saved chat says; only "Needs your OK" when it doesn't; and, when only
 * the Mac can answer, that it's waiting there.
 */
export function needsLine(agent: Agent, messages: AgentMessage[] | undefined): string {
  if (waitingOnMac(agent, messages)) return `${ON_MAC_LINE} · an import to review`;
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
/** A key as a label: `thread_id` → "Thread id", `sendAt` → "Send at". */
const fieldLabel = (key: string) => {
  const words = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/**
 * A connector tool's input (an email to send, a record to write) as labelled
 * fields, as the desk shows it, rather than its JSON. Null for anything else:
 * Claude Code's own tools come with a one-line detail. Every value in full:
 * it is what you're agreeing to.
 */
export function approvalFields(
  tool: string | undefined,
  input: unknown
): [string, string][] | null {
  if (!tool?.startsWith('mcp__') || !input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const fields = Object.entries(input as Record<string, unknown>).map(
    ([key, value]): [string, string] => [
      fieldLabel(key),
      typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    ]
  );
  return fields.length ? fields : null;
}

/**
 * How many lines a pending card's detail shows before "Show all": enough to
 * read a command or the start of a diff, few enough that the question, the
 * detail and Deny · Allow fit on a phone together without scrolling.
 */
export const DETAIL_LINES = 8;
/** At large text sizes each line is taller, so fewer of them. */
export const DETAIL_LINES_LARGE = 6;
/** A rough wrap width for field values in a phone card (characters per line). */
const FIELD_CHARS = 36;

/** The rows a value takes once wrapped, roughly: each line, at least one row. */
const fieldRows = (value: string) =>
  value.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / FIELD_CHARS)), 0);

/**
 * Fields under a line budget: each shown field with the most lines it may
 * take (`numberOfLines`), in order, until the budget is spent. `clipped` says
 * something was left out or cut, so the card offers "Show all": the full
 * text is always one tap away, never silently dropped.
 */
export function capFields(
  fields: [string, string][],
  budget: number
): { shown: [string, string, number][]; clipped: boolean } {
  const shown: [string, string, number][] = [];
  let left = budget;
  let clipped = false;
  for (const [label, value] of fields) {
    // A label and at least one line of its value, or it waits behind Show all.
    if (left < 2) {
      clipped = true;
      break;
    }
    left -= 1;
    const rows = fieldRows(value);
    const lines = Math.min(rows, left);
    if (rows > lines) clipped = true;
    shown.push([label, value, lines]);
    left -= lines;
  }
  return { shown, clipped };
}

/**
 * A skill offer's plain line, spoken to you as its card is ("When you ask
 * for last month's invoices"), not the Mac's fallback for an older client
 * ("When to use it: When the user asks…"). What the Mac adds after it (it
 * replaces one, details removed, outside content read) stays as it said it.
 */
export function skillSummary(approval: Pick<Approval, 'skill' | 'summary'>): string | null {
  const skill = approval.skill;
  if (!skill) return null;
  const when = skill.when.trim();
  const summary = approval.summary?.trim() ?? '';
  const prefix = `When to use it: ${when}`;
  const rest = summary.startsWith(prefix) ? summary.slice(prefix.length).trim() : '';
  const line = when ? skillWhenLine(when) : '';
  // The Mac runs what it adds straight on ("…payouts 1 personal detail…"): a stop between.
  const said = rest && line && !/[.!?…]$/.test(line) ? `${line}.` : line;
  return [said, rest].filter(Boolean).join(' ') || summary || null;
}

export function askingLine(
  approval: Pick<
    Approval,
    'title' | 'detail' | 'tool' | 'secret' | 'connector' | 'summary' | 'skill'
  >
): string {
  const offer = skillSummary(approval);
  if (offer) return offer;
  // The Mac's plain line, what and why (`admin::summary_for`), when it sent one.
  if (approval.summary?.trim() && !approval.connector && !approval.secret) return approval.summary;
  // These cards' titles are the request; their detail is the reassurance or
  // the purpose under it, which cut short only says half.
  // An import's review: the row says what to do, short; the card keeps its title.
  if (approval.connector?.kind === 'review') return 'Review the agents to import';
  if (approval.connector) return approval.title;
  if (approval.secret) return `Asks for “${secretTitle(approval.secret.name)}”`;
  if (approval.title === 'Run a command' && approval.detail?.trim())
    return commandLine(approval.detail);
  // A command whose title already says it in words: the title, never the command.
  if (approval.tool === 'Bash') return approval.title;
  const lines = (approval.detail ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const diff = lines.some((l) => diffLineKind(l) !== 'context' || /^(\+\+\+|---)\s/.test(l));
  // A connector tool's detail is its input as JSON (`describe_request`): its
  // first line is "{", and the title already says it ("Send an email · Gmail").
  const json = /^[{[]/.test(lines[0] ?? '');
  if (!diff && lines[0] && !json) return lines[0];
  const edit = /^do you want to make this edit to (.+?)\?*$/i.exec(approval.title.trim());
  if (edit) return `Wants to edit ${edit[1]}`;
  // A newer Mac's title says it plainly ("Edit Hero.tsx?"): the row says who wants it.
  const plain = /^(Edit|Create) (.+?)\?$/.exec(approval.title.trim());
  if (plain) return `Wants to ${plain[1].toLowerCase()} ${plain[2]}`;
  return approval.title;
}

type Chats = Record<string, { messages: AgentMessage[] } | undefined>;

/**
 * "2 need you · 3 working", over the agents shown on Home. Needs-you is the
 * one number every surface shows (`needsYouCount`, companion-protocol's
 * attention.ts): the quick action, and the desk's sidebar, review bar and
 * Dock badge. The Catch up tab's badge counts its own rows instead
 * (`feedItems`), cards rather than agents, so it matches its list. It once counted only what
 * the saved chats showed answerable here, and said 14 beside Home's 13.
 */
export function attentionCounts(agents: Agent[], setup?: TeamSetupView | null) {
  const shown = agents.filter((a) => !a.hidden);
  return {
    needYou: needsYouCount(agents, setup),
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
  chats: Chats,
  quiet: ReadonlySet<string> = new Set()
): { agentId: string; messageId?: string } | null {
  const next = sortAgents(agents.filter((a) => !a.hidden && !quiet.has(a.id))).find((a) =>
    needsYouHere(a, chats[a.id]?.messages)
  );
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

/** An expired card's receipt, as the desk words it (`expiryLine` in src/lib/agents.ts). */
const EXPIRY_OUTCOME = {
  moved_on: 'Expired',
  no_answer: 'No answer',
  maybe_later: 'Maybe later',
} as const;

/** An answered card in a line, as the desk words it (with the option picked on a session's question). */
/** A step-in card on the phone: Step in happens at the Mac (worded once, with the desk). */
export {
  STEP_IN_AT_MAC,
  STEP_IN_FROM_HERE,
  STEP_IN_ON_YOUR_MAC,
  stepInOnPhone,
} from '@shipstudio/companion-protocol';

export function cardOutcome(approval: Approval): string {
  // Nobody answered: what the desk's receipt says.
  if (approval.status === 'expired' && approval.expiry) return EXPIRY_OUTCOME[approval.expiry];
  // "Save … as a skill?": Saved or Not now, as the desk says it.
  if (approval.skill) {
    const said = skillOutcome(approval.status);
    if (said) return said;
  }
  // "Needs you in its browser": the desk's words.
  if (approval.stepIn && (approval.status !== 'expired' || approval.setAside)) {
    return stepInOutcome(approval);
  }
  // "Carry on with Codex?": Wait, Just this time or Always, as the desk says it.
  if (approval.crossover && approval.status !== 'expired') {
    return crossoverOutcome(approval.crossover, approval.status, approval.choice) ?? '';
  }
  // Closed by the Mac, not answered: why, in its own words ("Nothing ran").
  if (approval.setAside) {
    const why = approval.setAside.replace(/^Set aside:\s*/i, '');
    return `Set aside · ${why.charAt(0).toUpperCase()}${why.slice(1)}`;
  }
  if (approval.alwaysAllowed && approval.always) {
    const how = approval.always.said ? 'Allowed by your rule' : 'Always allowed';
    return `${how} · ${approval.always.label}`;
  }
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

/**
 * A search hit's snippet is raw message text: drop the markdown a reader
 * never sees. Emphasis and heading marks go; a table's separator row goes,
 * and its cells read "Renewal pricing · Dana at Northwind" rather than
 * "| --- | --- | Renewal pricing | Dana…".
 */
export function plainSnippet(snippet: string): string {
  return snippet
    .replace(/\*\*|__|`+|^#+\s*/gm, '')
    .replace(/\|?(\s*:?-{3,}:?\s*\|)+(\s*:?-{3,}:?\s*)?/g, ' ')
    .replace(/(\s*\|\s*)+/g, ' · ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
