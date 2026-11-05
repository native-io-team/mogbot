/**
 * A task's terminal, read as a conversation (the task screen): the steps it
 * took in plain words, what it said, and every line that says something went
 * wrong, with the terminal's machinery left out — the input box, the spinner
 * and its "esc to interrupt", the shortcut hints, tool output and box edges.
 *
 * Nothing here is guessed. What it was sent comes only from the Mac
 * (`SessionScreen.sent`), never from a pointer line on the screen, and the
 * reading starts there only when that text is found on the screen; otherwise
 * it reads the whole screen. A line this doesn't recognise is kept as words,
 * a prompt it can't draw is kept whole (`prompt`), and the raw screen is one
 * tap away (and opens by itself when the reading may be missing something).
 *
 * Pure, so tested (`__tests__/taskScreen.test.ts`).
 */

/** One piece of the conversation, in screen order. */
export type TaskPart =
  /** A tool call, in plain words ("Edited Hero.tsx"). */
  | { kind: 'step'; text: string }
  /** A paragraph in the agent's own words. */
  | { kind: 'said'; text: string }
  /** Something went wrong or was cut off, verbatim ("API Error: 529"). */
  | { kind: 'notice'; text: string }
  /** A message typed into the terminal, verbatim with its pointer. Who typed it isn't known. */
  | { kind: 'typed'; text: string };

export interface TaskReading {
  /** What the Mac says it sent, when that text is on the screen and the reading starts after it. */
  asked?: string;
  parts: TaskPart[];
  /** A prompt or menu at the bottom of the screen, its lines kept whole (borders stripped). */
  prompt?: string[];
}

const POINTERS = ['>', '❯', '›', '▶', '→'];
/** Claude Code marks a tool call or a paragraph with ⏺; Codex with •. */
const BULLETS = ['⏺', '●', '•'];
/** Claude Code's spinner frames, and a braille spinner. Nothing else counts as a status line. */
const SPINNERS = ['·', '✢', '✳', '✶', '✻', '✽', '*', '✺', '✹'];
/** Codex marks an error with ■; both mark a warning with ⚠. */
const ALERTS = ['■', '⚠', '✗', '✘', '×'];

const base = (path: string) => path.trim().replace(/\/+$/, '').split('/').pop() || path.trim();

const flat = (text: string) => text.trim().replace(/\s+/g, ' ');

/** A rule or an edge with nothing written in it. */
const isRule = (t: string) => /^[│┃║╭╮╰╯├┤┬┴┼┌┐└┘─━═┄┈╌▌▐|+\-=_~\s]+$/.test(t) && /[─━═┄┈╌\-=_~]{3,}/.test(t);
const isEdgeOnly = (t: string) => /^[│┃║╭╮╰╯├┤┬┴┼┌┐└┘─━═┄┈╌▌▐|\s]+$/.test(t);

/** A line inside a box, without the box: "│ Do you want…? │" → "Do you want…?". */
function unboxed(raw: string): string {
  let t = raw.trim();
  for (let i = 0; i < 2; i++) {
    t = t.replace(/^[│┃║▌▐]\s?/, '').replace(/\s?[│┃║▌▐]$/, '').trim();
  }
  return t;
}

/** The machinery under and around the input box. */
function isNoise(t: string): boolean {
  const lower = t.toLowerCase();
  return (
    lower.includes('esc to interrupt') ||
    lower.includes('esc interrupt') ||
    lower.includes('? for shortcuts') ||
    lower.includes('shift+tab to cycle') ||
    lower.includes('ctrl+') ||
    lower.includes('context left') ||
    // Codex's footer: "⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit".
    t.includes('⌃') ||
    lower.includes('⏎ send') ||
    lower.includes('⏵⏵') ||
    isStatusLine(t)
  );
}

/**
 * A spinner line: one of the spinners' own glyphs, then a word, with an
 * ellipsis or an elapsed time ("✻ Checking the hero… (12s)", "✻ Cogitated
 * for 4s"). Any other glyph — Codex's "■ stream error", a ⚠ — is words.
 */
export function isStatusLine(t: string): boolean {
  const first = t.codePointAt(0);
  if (first === undefined) return false;
  const glyph = String.fromCodePoint(first);
  if (!SPINNERS.includes(glyph) && !(first >= 0x2800 && first <= 0x28ff)) return false;
  const rest = t.slice(glyph.length).trimStart();
  if (!/^\p{L}/u.test(rest)) return false;
  return (
    rest.includes('…') ||
    /\(\d+[sm]\b/.test(rest) ||
    /\bfor \d+[sm]\b/.test(rest) ||
    rest.includes('· done')
  );
}

/** Words under a tool call that say it went wrong or was cut off. */
const TROUBLE = /\b(error|errored|failed|failure|interrupted|retrying|timed out|rejected|denied)\b/i;

/** A count of nothing ("0 failed", "no errors") is good news, not trouble. */
const troubled = (out: string) =>
  TROUBLE.test(out.replace(/\b(0|no) (failed|failures?|errors?)\b/gi, ''));

/** "1. Yes", with or without the pointer on it. */
const OPTION = /^\d{1,2}\.\s+\S/;
const pointerOf = (t: string) => POINTERS.find((p) => t.startsWith(p));
/** A prompt's question: a permission, a confirmation. */
const ASKING =
  /^(do you want|would you like|allow|approve|proceed|are you sure|confirm|continue)\b.*\?\s*(\(.*\))?$/i;

/** How far up from the bottom a prompt still showing can start. */
const PROMPT_REACH = 40;

/**
 * The prompt at the bottom of the screen, if there is one: from the edge or
 * rule above its first option or question, to the end, borders stripped and
 * nothing else dropped. Returns where it starts and its lines.
 */
function findPrompt(lines: string[]): { from: number; lines: string[] } | null {
  const floor = Math.max(0, lines.length - PROMPT_REACH);
  const isChoice = (t: string) => {
    const p = pointerOf(t);
    const rest = p === undefined ? t : t.slice(p.length).trim();
    return OPTION.test(rest) || (p !== undefined && /^(yes|no)\b/i.test(rest));
  };
  let first = -1;
  for (let i = floor; i < lines.length; i++) {
    const t = unboxed(lines[i]);
    const p = pointerOf(t);
    // A highlighted option ("❯ 1. Yes", "▶ Yes"): a menu is showing.
    if (p !== undefined && isChoice(t)) {
      first = i;
      break;
    }
    // A question with choices under it. A question in the agent's reply has none.
    const asking = !BULLETS.some((b) => t.startsWith(b)) && ASKING.test(t);
    if (asking && lines.slice(i + 1, i + 12).some((l) => isChoice(unboxed(l)))) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  // Up to the edge, rule or reply above it: the prompt's own header ("Edit file") and diff are in it.
  let from = first;
  while (from > floor) {
    const above = lines[from - 1].trim();
    // A box just above the question (the edit's diff) is the prompt's: take it whole.
    if (/^[╰└]/.test(above)) {
      let top = from - 1;
      while (top > floor && !/^[╭┌]/.test(lines[top].trim())) top--;
      if (/^[╭┌]/.test(lines[top].trim())) {
        from = top;
        continue;
      }
    }
    // The outer edge or rule; a box inside it (a diff) starts with the outer border.
    if ((isRule(above) && !/^[│┃║]/.test(above)) || /^[╭┌]/.test(above)) break;
    if (BULLETS.some((b) => above.startsWith(b))) break;
    if (!above && !lines[from - 2]?.trim()) break;
    from--;
  }
  const kept = lines
    .slice(from)
    .map(unboxed)
    .filter((t) => t && !isEdgeOnly(t) && !isRule(t));
  return kept.length ? { from, lines: kept } : null;
}

/**
 * Where the message the Mac sent sits on the screen: the last line holding
 * its first words, and the lines it wrapped onto. -1 when it isn't there.
 */
function findSent(lines: string[], sent: string): number {
  const all = flat(sent);
  if (all.length < 3) return -1;
  const needle = all.slice(0, 40);
  const words = (l: string) => {
    const t = flat(unboxed(l));
    const p = pointerOf(t);
    return p === undefined ? t : t.slice(p.length).trim();
  };
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = words(lines[i]);
    // Its first words, or a narrow screen's first line of it.
    if (t.includes(needle) || (t.length >= Math.min(all.length, 12) && all.startsWith(t))) {
      at = i;
      break;
    }
  }
  if (at < 0) return -1;
  while (at + 1 < lines.length) {
    const next = words(lines[at + 1]);
    if (!next || !all.includes(next)) break;
    at++;
  }
  return at;
}

/** "Read(src/components/Hero.tsx)" → "Read Hero.tsx"; null when it isn't a tool call. */
export function stepLabel(call: string): string | null {
  // Claude Code draws a call as "Name(args)", an MCP tool as "snake_name (args)".
  // A word and a bracket in a sentence ("Done (all good)") is neither.
  const m =
    /^([A-Za-z_][\w.-]*)\((.*)\)\s*$/.exec(call.trim()) ??
    /^([a-z][\w-]*_[\w-]*)\s\((.*)\)\s*$/.exec(call.trim());
  if (!m) return null;
  const [, name, args] = m;
  // The first argument, without its name ("device: phone" → "phone"; a URL keeps its scheme).
  const first = args.split(/,\s*(?=\w+:\s)/)[0]?.replace(/^\w+:\s+/, '') ?? '';
  const tool = name.replace(/^mcp__[^_]+__/, '');
  switch (tool) {
    case 'Read':
      return `Read ${base(first)}`;
    case 'Update':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edited ${base(first)}`;
    case 'Write':
    case 'Create':
      return `Wrote ${base(first)}`;
    case 'Bash':
      return `Ran ${flat(first)}`;
    case 'Grep':
    case 'Glob':
    case 'Search':
      return 'Searched the files';
    case 'WebFetch':
    case 'Fetch':
      try {
        return `Read ${new URL(first.trim()).host}`;
      } catch {
        return 'Read a web page';
      }
    case 'WebSearch':
      return 'Searched the web';
    case 'TodoWrite':
      return 'Updated its to-do list';
    case 'Task':
    case 'Agent':
      return 'Started a helper';
    default:
      if (/screenshot/i.test(tool)) return 'Took a screenshot';
      return `Used ${tool.replace(/[_-]+/g, ' ').trim()}`;
  }
}

/** Codex's own step lines ("• Ran pnpm test", "• Edited Hero.tsx") are already words. */
const CODEX_STEP = /^(Ran|Edited|Explored|Read|Searched|Added|Deleted|Created|Wrote|Listed)\b/;

/**
 * Read a task's screen. With `sent` (what the Mac reports it typed in),
 * found on the screen, only what follows it counts; otherwise all of it.
 */
export function readTaskScreen(screen: string, sent?: string): TaskReading {
  let lines = screen.replace(/\r/g, '').split('\n');
  const prompt = findPrompt(lines);
  if (prompt) lines = lines.slice(0, prompt.from);

  const at = sent ? findSent(lines, sent) : -1;
  const asked = at >= 0 && sent ? flat(sent) : undefined;
  const body = lines.slice(at + 1);

  // The input box at the bottom: a pointer line with only machinery after it
  // (Codex's placeholder "› Implement {feature}" is one). It isn't a message.
  let inputBox = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    const t = unboxed(body[i]);
    if (!t || isNoise(t) || isEdgeOnly(t) || isRule(t)) continue;
    if (pointerOf(t) !== undefined) inputBox = i;
    break;
  }

  const parts: TaskPart[] = [];
  let mode: 'prose' | 'tool' | 'none' = 'none';
  const say = (text: string, fresh: boolean) => {
    const last = parts[parts.length - 1];
    if (!fresh && last?.kind === 'said') last.text += ` ${text}`;
    else parts.push({ kind: 'said', text });
  };
  body.forEach((raw, i) => {
    if (i === inputBox) return;
    const t = unboxed(raw);
    if (!t) {
      if (mode === 'prose') mode = 'none';
      return;
    }
    if (isNoise(t) || isEdgeOnly(t) || isRule(t)) return;
    // A box under a tool call (a diff, a file), or Codex's "└ output": its output.
    if (mode === 'tool' && /^[│┃║└]/.test(raw.trim())) return;
    const pointer = pointerOf(t);
    // A pointer indented under a tool call ("    > astro build") is its output.
    if (pointer !== undefined && !(mode === 'tool' && /^\s{2,}/.test(raw))) {
      const words = t.slice(pointer.length).trim();
      if (words) parts.push({ kind: 'typed', text: `${pointer} ${words}` });
      mode = 'none';
      return;
    }
    if (ALERTS.some((a) => t.startsWith(a))) {
      parts.push({ kind: 'notice', text: t.slice(1).trim() });
      mode = 'none';
      return;
    }
    // Indented under a tool call: its output, unless it says something went wrong.
    if (mode === 'tool' && /^\s{2,}/.test(raw) && !t.startsWith('⎿')) {
      if (/^(api )?error\b|^error:|\binterrupted\b|\bretrying\b/i.test(t)) {
        parts.push({ kind: 'notice', text: t });
      }
      return;
    }
    // A tool's output, under its call: left out, unless it says something went wrong.
    if (t.startsWith('⎿')) {
      const out = t.slice(1).trim();
      if (troubled(out)) parts.push({ kind: 'notice', text: out });
      mode = 'tool';
      return;
    }
    const bullet = BULLETS.find((b) => t.startsWith(b));
    if (bullet) {
      const said = t.slice(bullet.length).trim();
      const label = bullet === '•' ? null : stepLabel(said);
      if (label) {
        parts.push({ kind: 'step', text: label });
        mode = 'tool';
      } else if (bullet === '•' && CODEX_STEP.test(said)) {
        parts.push({ kind: 'step', text: flat(said) });
        mode = 'tool';
      } else {
        say(said, true);
        mode = 'prose';
      }
      return;
    }
    say(t, mode !== 'prose');
    mode = 'prose';
  });
  return {
    ...(asked ? { asked } : {}),
    parts,
    ...(prompt ? { prompt: prompt.lines } : {}),
  };
}

/** The reading's steps, its words and its notices, each on its own (for tests and labels). */
export const stepsOf = (r: TaskReading) =>
  r.parts.filter((p) => p.kind === 'step').map((p) => p.text);
export const saidOf = (r: TaskReading) =>
  r.parts
    .filter((p) => p.kind === 'said')
    .map((p) => p.text)
    .join('\n\n');
export const noticesOf = (r: TaskReading) =>
  r.parts.filter((p) => p.kind === 'notice').map((p) => p.text);

/**
 * Open the raw terminal without being asked: when the reading holds no words
 * of the agent's, when it isn't working (finished, stopped, asking, ended:
 * the screen is what to check), when something went wrong, or when there is
 * a prompt the Mac didn't read as a question.
 */
export function terminalFirst(
  r: TaskReading,
  state: 'working' | 'needs_decision' | 'finished' | 'exited',
  macQuestion: boolean
): boolean {
  if (state !== 'working') return true;
  if (!r.parts.some((p) => p.kind === 'said')) return true;
  if (r.parts.some((p) => p.kind === 'notice')) return true;
  return !!r.prompt && !macQuestion;
}

/**
 * The spinner's words, for a person: "Checking the hero at 390px… (12s)" →
 * "Checking the hero at 390px". The time is the terminal's; the phone says
 * when it last heard from the task instead.
 */
export function plainActivity(activity: string): string {
  return activity
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/(…|\.\.\.)\s*$/, '')
    .trim();
}
