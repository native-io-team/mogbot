/**
 * A unified diff (`agents.changeDiff`'s `content`) as the review screen draws
 * it: hunks of rows with the old and new line numbers, long runs of unchanged
 * lines folded to "12 unchanged lines", and, where a removed line is followed
 * by the line that replaced it, the words that changed picked out. Pure, so
 * it's tested; nothing here guesses at a line it wasn't given.
 */

export type RowKind = 'add' | 'del' | 'context';

/** A stretch of a line: `changed` when it's what differs from its pair. */
export interface Span {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  kind: RowKind;
  /** The line without its leading `+`/`-`/space. */
  text: string;
  /** Its number in the old file (none for an added line). */
  oldNo?: number;
  /** Its number in the new file (none for a removed line). */
  newNo?: number;
  /** Set when the line has a pair to compare with: what changed in it. */
  spans?: Span[];
}

/** Unchanged lines folded away, opened with a tap. */
export interface Fold {
  kind: 'fold';
  rows: DiffRow[];
}

export interface Hunk {
  /** `@@ -12,7 +12,9 @@ function name` → "function name", when git gave one. */
  context?: string;
  /** Where the hunk starts in the new file. */
  newStart: number;
  parts: (DiffRow | Fold)[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/** Unchanged lines kept on each side of a change; a longer run between is folded. */
export const CONTEXT_KEPT = 3;
/** A fold shorter than this isn't worth the tap: shown as it is. */
const FOLD_MIN = 4;
/** Lines this long are compared whole, not word by word (too slow, and unreadable lit). */
const WORD_DIFF_MAX = 400;

/** Parse a unified diff. Lines before the first `@@` (headers) are dropped. */
export function parseDiff(content: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: { context?: string; newStart: number; rows: DiffRow[] } | null = null;
  let oldNo = 0;
  let newNo = 0;
  const flush = () => {
    if (hunk)
      hunks.push({
        context: hunk.context,
        newStart: hunk.newStart,
        parts: fold(pairWords(hunk.rows)),
      });
  };
  for (const line of content.replace(/\n$/, '').split('\n')) {
    const head = HUNK.exec(line);
    if (head) {
      flush();
      oldNo = Number(head[1]);
      newNo = Number(head[2]);
      hunk = { context: head[3]?.trim() || undefined, newStart: newNo, rows: [] };
      continue;
    }
    if (!hunk) continue;
    // "\ No newline at end of file" is git's note, not a line of the file.
    if (line.startsWith('\\')) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') hunk.rows.push({ kind: 'add', text, newNo: newNo++ });
    else if (mark === '-') hunk.rows.push({ kind: 'del', text, oldNo: oldNo++ });
    else hunk.rows.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
  }
  flush();
  return hunks;
}

/**
 * Each run of removed lines followed by a run of added ones is compared line
 * for line (the first removed with the first added, and so on), and both get
 * the words that differ picked out. Lines with no pair stay whole.
 */
function pairWords(rows: DiffRow[]): DiffRow[] {
  const out = rows.map((r) => ({ ...r }));
  let i = 0;
  while (i < out.length) {
    if (out[i].kind !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < out.length && out[i].kind === 'del') i++;
    const addStart = i;
    while (i < out.length && out[i].kind === 'add') i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const del = out[delStart + k];
      const add = out[addStart + k];
      const spans = wordSpans(del.text, add.text);
      if (spans) {
        del.spans = spans.old;
        add.spans = spans.new;
      }
    }
  }
  return out;
}

/** Words, runs of spaces and single punctuation marks: what a reader sees as one change. */
const tokens = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];

/**
 * The two lines as spans, what differs marked, from the longest common run of
 * tokens. None when the lines are too long, or share so little that lighting
 * the differences would light nearly everything (then the band says it).
 */
export function wordSpans(a: string, b: string): { old: Span[]; new: Span[] } | null {
  if (a.length > WORD_DIFF_MAX || b.length > WORD_DIFF_MAX) return null;
  const x = tokens(a);
  const y = tokens(b);
  const n = x.length;
  const m = y.length;
  // Longest common subsequence, by table: lines are short, so this is cheap.
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const keepX = new Array<boolean>(n).fill(false);
  const keepY = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      keepX[i++] = true;
      keepY[j++] = true;
    } else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  const shared = x.reduce((sum, tok, k) => (keepX[k] && tok.trim() ? sum + tok.length : sum), 0);
  const longest = Math.max(a.trim().length, b.trim().length);
  if (longest === 0 || shared / longest < 0.3) return null;
  return { old: spansOf(x, keepX), new: spansOf(y, keepY) };
}

function spansOf(toks: string[], kept: boolean[]): Span[] {
  const spans: Span[] = [];
  toks.forEach((tok, k) => {
    // Whitespace alone between two changes reads as part of the change.
    const changed = !kept[k];
    const last = spans[spans.length - 1];
    if (last && last.changed === changed) last.text += tok;
    else spans.push({ text: tok, changed });
  });
  return spans;
}

/** Fold runs of unchanged lines longer than the context kept around changes. */
function fold(rows: DiffRow[]): (DiffRow | Fold)[] {
  const out: (DiffRow | Fold)[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'context') {
      out.push(rows[i++]);
      continue;
    }
    const start = i;
    while (i < rows.length && rows[i].kind === 'context') i++;
    const run = rows.slice(start, i);
    const lead = start === 0 ? 0 : CONTEXT_KEPT;
    const tail = i === rows.length ? 0 : CONTEXT_KEPT;
    if (run.length - lead - tail < FOLD_MIN) {
      out.push(...run);
      continue;
    }
    out.push(...run.slice(0, lead));
    out.push({ kind: 'fold', rows: run.slice(lead, run.length - tail) });
    out.push(...run.slice(run.length - tail));
  }
  return out;
}

/** A path as a reader takes it in: the file's name, then the folder it's in. */
export function splitPath(path: string): { name: string; folder: string } {
  const at = path.lastIndexOf('/');
  return at < 0
    ? { name: path, folder: '' }
    : { name: path.slice(at + 1), folder: path.slice(0, at) };
}

/**
 * The quote "Ask for a change here" puts in the composer: the file, the line
 * and the line itself as it reads now (or as it read, for a removed line).
 */
export function lineQuote(path: string, row: DiffRow): string {
  const no = row.newNo ?? row.oldNo;
  const where = row.kind === 'del' ? `${path}, removed line ${no}` : `${path}:${no}`;
  return `${where}\n${row.text.trim()}`;
}
