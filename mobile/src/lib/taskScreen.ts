/**
 * A task's terminal, read as a conversation (the task screen): what it was
 * asked, the steps it took in plain words, and what it said, with the
 * terminal's machinery left out — the input box, the spinner and its "esc to
 * interrupt", the shortcut hints, tool output and boxes. The same reading
 * the Mac does for Remote Access (`remote_access/agent_state.rs`), from the
 * screen the phone already has, so nothing here is guessed: a line this
 * doesn't recognise is kept as words, and the raw screen is one tap away.
 *
 * Pure, so tested (`__tests__/taskScreen.test.ts`).
 */

export interface TaskReading {
  /** The newest message the task was given, as it echoed it. */
  asked?: string;
  /** What it did since, oldest first, in plain words ("Edited Hero.tsx"). */
  steps: string[];
  /** What it said since, as paragraphs. */
  said: string;
}

const POINTERS = ['>', '❯', '›'];
/** Claude Code marks a tool call or a paragraph with ⏺; Codex with •. */
const BULLETS = ['⏺', '●', '•'];

const base = (path: string) => path.trim().replace(/\/+$/, '').split('/').pop() || path.trim();

const flat = (text: string) => text.trim().replace(/\s+/g, ' ');

/** A box, a rule or a table edge: drawing, not words. */
const isDrawing = (t: string) =>
  /^[│┃╭╮╰╯├┤┌┐└┘─━═┄┈|+\-=_~·.\s]+$/.test(t) || /^[│┃╭╰├┌└]/.test(t);

/** The machinery under and around the input box. */
function isNoise(t: string): boolean {
  const lower = t.toLowerCase();
  return (
    lower.includes('esc to interrupt') ||
    lower.includes('esc interrupt') ||
    lower.includes('? for shortcuts') ||
    lower.includes('shift+tab') ||
    lower.includes('ctrl+') ||
    lower.includes('⏵⏵') ||
    isStatusLine(t)
  );
}

/**
 * A spinner or status line: a glyph, then a word, with an ellipsis or an
 * elapsed time ("✻ Checking the hero… (12s)", "✻ Cogitated for 4s · done").
 * The task's state is said above the conversation, in words, instead.
 */
function isStatusLine(t: string): boolean {
  const first = t.codePointAt(0);
  if (first === undefined) return false;
  const glyph = String.fromCodePoint(first);
  if (/[\p{L}\p{N}]/u.test(glyph) || POINTERS.includes(glyph) || BULLETS.includes(glyph)) {
    return false;
  }
  if (glyph === '⎿' || glyph === '│' || glyph === '⚠') return false;
  const rest = t.slice(glyph.length).trimStart();
  if (!/^\p{L}/u.test(rest)) return false;
  return rest.includes('…') || /\(\d+[sm]\b/.test(rest) || rest.includes('· done');
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
 * Read a task's screen. Only what follows the last message it was given
 * counts: everything above it belongs to an earlier exchange.
 */
export function readTaskScreen(screen: string): TaskReading {
  const lines = screen.replace(/\r/g, '').split('\n');
  // The input box at the bottom is an empty pointer line: the last echoed
  // prompt is the last pointer line with words after it.
  let start = -1;
  let asked: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    const p = POINTERS.find((x) => t.startsWith(x));
    if (!p) continue;
    const words = t.slice(p.length).trim();
    // A numbered option ("❯ 1. Yes") is a menu, not a message.
    if (!words || /^\d+\.\s/.test(words)) continue;
    start = i;
    asked = words;
    // A long message wraps: its following lines that aren't marked are part of it.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || BULLETS.some((b) => next.startsWith(b)) || isNoise(next) || isDrawing(next)) {
        break;
      }
      asked += ` ${next}`;
      start = j;
    }
    break;
  }

  const steps: string[] = [];
  const paragraphs: string[][] = [];
  let mode: 'prose' | 'tool' | 'none' = 'none';
  const say = (text: string, fresh: boolean) => {
    if (fresh || !paragraphs.length) paragraphs.push([text]);
    else paragraphs[paragraphs.length - 1].push(text);
  };
  for (const raw of lines.slice(start + 1)) {
    const t = raw.trim();
    if (!t) {
      if (mode === 'prose') mode = 'none';
      continue;
    }
    if (isNoise(t) || isDrawing(t)) continue;
    if (POINTERS.some((p) => t.startsWith(p))) continue;
    // A tool's output, under its call.
    if (t.startsWith('⎿')) {
      mode = 'tool';
      continue;
    }
    const bullet = BULLETS.find((b) => t.startsWith(b));
    if (bullet) {
      const body = t.slice(bullet.length).trim();
      const label = bullet === '•' ? null : stepLabel(body);
      if (label) {
        steps.push(label);
        mode = 'tool';
      } else if (bullet === '•' && CODEX_STEP.test(body)) {
        steps.push(flat(body));
        mode = 'tool';
      } else {
        say(body, true);
        mode = 'prose';
      }
      continue;
    }
    // Indented under a tool call: its output.
    if (mode === 'tool' && /^\s{2,}/.test(raw)) continue;
    say(t, mode !== 'prose');
    mode = 'prose';
  }
  return {
    ...(asked ? { asked } : {}),
    steps,
    said: paragraphs.map((p) => p.join(' ')).join('\n\n'),
  };
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
