/**
 * Blocks (`show`, `src-tauri/src/agents/blocks.rs`): the right UI at the
 * right moment. An agent answers with data, never markup: a chart from its
 * numbers, a table, metric tiles, a checklist, a comparison with "Pick this",
 * quick replies, a short form. The Mac validates every block before it is
 * kept; the desk and the phone draw them from the same types and the same
 * pure maths here, so both show the same thing from the same message.
 *
 * Nothing in a block is HTML or code that runs. Text is drawn as text; a
 * link is a chip with its domain (no favicon is ever fetched); an image is
 * one of the agent's own files, copied into the chat like any attachment.
 *
 * Answering one (a choice, Pick this, a form) sends the user's own message
 * through the ordinary send path, so independence and approvals are
 * unchanged. A set posted while the agent was answering outside text
 * (`fromOutside`) never sends on a tap: the words go into the composer for
 * the user to read and send.
 */

import type { AgentMessage, Attachment } from './model';

/** The block format this build draws. A newer set falls back to its text. */
export const BLOCKS_VERSION = 1;

export interface BlockSet {
  v: number;
  /** The agent's words above the blocks (markdown, through the usual sanitizer). */
  intro?: string;
  items: Block[];
  /** Posted while the agent was answering outside text: taps stage, never send. */
  fromOutside?: boolean;
}

interface Base {
  /** A plain-text version of the block: what older clients and search show. */
  summary: string;
  title?: string;
}

export type ChartType = 'line' | 'bar' | 'area' | 'pie' | 'donut' | 'sparkline';

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

export interface ChartBlock extends Base {
  kind: 'chart';
  chart: ChartType;
  labels: string[];
  series: ChartSeries[];
  stacked?: boolean;
  prefix?: string;
  suffix?: string;
  /** What the value axis measures ("Visitors"). */
  axis?: string;
}

export type Cell = string | number | null;

export interface TableColumn {
  label: string;
  /** Every non-empty cell is a number: right-aligned, tabular, sorted as numbers. */
  numeric?: boolean;
  prefix?: string;
  suffix?: string;
}

export interface TableBlock extends Base {
  kind: 'table';
  columns: TableColumn[];
  rows: Cell[][];
}

export interface Metric {
  label: string;
  value: number | string;
  prefix?: string;
  suffix?: string;
  /** A number (formatted with the value's units and a sign) or the agent's own words ("+12%"). */
  delta?: number | string;
  /** What the delta is against ("vs last week"). */
  vs?: string;
  /** Which way is good. Default up. */
  good?: 'up' | 'down';
  trend?: number[];
}

export interface MetricsBlock extends Base {
  kind: 'metrics';
  items: Metric[];
}

export interface Fact {
  label: string;
  value: string;
}

export interface FactsBlock extends Base {
  kind: 'facts';
  items: Fact[];
}

export interface ChecklistBlock extends Base {
  kind: 'checklist';
  items: { text: string; done: boolean; note?: string }[];
}

export type StepStatus = 'done' | 'current' | 'todo' | 'failed';

export interface StepsBlock extends Base {
  kind: 'steps';
  items: { title: string; detail?: string; status: StepStatus; when?: string }[];
}

export interface ComparisonOption {
  name: string;
  summary?: string;
  pros: string[];
  cons: string[];
  facts?: Fact[];
  recommended?: boolean;
  /** What "Pick this" sends, as the user. */
  reply: string;
}

export interface ComparisonBlock extends Base {
  kind: 'comparison';
  options: ComparisonOption[];
}

export interface ChoicesBlock extends Base {
  kind: 'choices';
  question?: string;
  options: { label: string; reply: string }[];
}

export type FieldType = 'text' | 'long_text' | 'choice' | 'date' | 'number';

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  options?: string[];
  required?: boolean;
  placeholder?: string;
}

export interface FormBlock extends Base {
  kind: 'form';
  fields: FormField[];
  /** The button's words. */
  submit: string;
}

export interface LinksBlock extends Base {
  kind: 'links';
  items: { url: string; label: string; domain: string; note?: string }[];
}

export type CalloutTone = 'info' | 'warning' | 'success';

export interface CalloutBlock extends Base {
  kind: 'callout';
  tone: CalloutTone;
  text: string;
}

export interface CodeBlock extends Base {
  kind: 'code';
  language?: string;
  code: string;
}

export interface ImageBlock extends Base {
  kind: 'image';
  /** The agent's file, copied into the chat (also in the message's attachments). */
  file: Attachment;
  caption?: string;
}

/**
 * A step of first run's "bring your agents over" guide (`agents::guide`):
 * only the Mac posts these, never an agent's `show`. Drawn as that step's
 * one action on the desk; `summary` is where it happens ("On your Mac: …"), which the phone shows.
 */
export type GuideStepId =
  | 'tailscale'
  | 'link'
  | 'approve'
  | 'connect'
  | 'send'
  | 'talking'
  /** "I'm starting fresh": the Chief asks what to do; the desk puts the starters under it. */
  | 'fresh';
export type GuideAssistant = 'grok' | 'chatgpt' | 'claude' | 'other';
export const GUIDE_STEPS: readonly GuideStepId[] = [
  'tailscale',
  'link',
  'approve',
  'connect',
  'send',
  'talking',
];

export interface GuideBlock extends Base {
  kind: 'guide';
  step: GuideStepId;
  assistant: GuideAssistant;
}

export type Block =
  | GuideBlock
  | ChartBlock
  | TableBlock
  | MetricsBlock
  | FactsBlock
  | ChecklistBlock
  | StepsBlock
  | ComparisonBlock
  | ChoicesBlock
  | FormBlock
  | LinksBlock
  | CalloutBlock
  | CodeBlock
  | ImageBlock;

export type BlockKind = Block['kind'];

export const BLOCK_KINDS: readonly BlockKind[] = [
  'chart',
  'table',
  'metrics',
  'facts',
  'checklist',
  'steps',
  'comparison',
  'choices',
  'form',
  'links',
  'callout',
  'code',
  'image',
];

/** How many categorical slots the palette has (`--chart-series-1…8`). */
export const SERIES_SLOTS = 8;

/** Table rows shown before "Show all". */
export const TABLE_ROWS_SHOWN = 8;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The set, if this build can draw it: the right version, and only blocks of
 * a kind it knows with the fields each one reads. A block that isn't is
 * dropped; a set with nothing left is null, and the message shows its text.
 */
export function readBlocks(message: Pick<AgentMessage, 'blocks'>): BlockSet | null {
  const raw: unknown = message.blocks;
  if (!isObject(raw) || raw.v !== BLOCKS_VERSION || !Array.isArray(raw.items)) return null;
  const items = raw.items.filter(wellFormed);
  if (!items.length) return null;
  return {
    v: BLOCKS_VERSION,
    items,
    ...(typeof raw.intro === 'string' && raw.intro.trim() ? { intro: raw.intro } : {}),
    ...(raw.fromOutside === true ? { fromOutside: true } : {}),
  };
}

const arr = (v: unknown): v is unknown[] => Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

function wellFormed(b: unknown): b is Block {
  if (!isObject(b) || !str(b.kind) || !str(b.summary)) return false;
  switch (b.kind) {
    case 'chart':
      return (
        str(b.chart) &&
        arr(b.labels) &&
        arr(b.series) &&
        b.series.length > 0 &&
        b.series.every((s) => isObject(s) && str(s.name) && arr(s.values))
      );
    case 'table':
      return arr(b.columns) && arr(b.rows) && b.rows.every(arr);
    case 'metrics':
    case 'facts':
    case 'checklist':
    case 'steps':
    case 'links':
      return arr(b.items) && b.items.every(isObject);
    case 'comparison':
      return (
        arr(b.options) &&
        b.options.every((o) => isObject(o) && str(o.name) && arr(o.pros) && arr(o.cons))
      );
    case 'choices':
      return arr(b.options) && b.options.every((o) => isObject(o) && str(o.label));
    case 'form':
      return arr(b.fields) && b.fields.every((f) => isObject(f) && str(f.id) && str(f.label));
    case 'callout':
      return str(b.text);
    case 'code':
      return str(b.code);
    case 'image':
      return isObject(b.file) && str(b.file.path);
    case 'guide':
      return (
        str(b.step) &&
        (b.step === 'fresh' || (GUIDE_STEPS as readonly string[]).includes(b.step)) &&
        str(b.assistant)
      );
    default:
      return false;
  }
}

/** Blocks that send words as the user. */
export function isInteractive(block: Block): boolean {
  return block.kind === 'choices' || block.kind === 'comparison' || block.kind === 'form';
}

/**
 * Kinds that read as a section of a page: records and notes, nothing drawn
 * and nothing to answer. Two or more in a row share one card.
 */
const PAGE_KINDS: ReadonlySet<BlockKind> = new Set([
  'facts',
  'table',
  'checklist',
  'steps',
  'callout',
]);

/**
 * A set's blocks as the desk and the phone lay them out: each run of two or
 * more page kinds (facts, a table, a checklist, steps, a note) is one card
 * with a section each, so a brief reads as one page rather than a pile of
 * boxes; everything else (charts, tiles, choices, a form…) stands alone.
 * A run made only of notes stays as notes.
 */
export function blockRuns(items: readonly Block[]): Block[][] {
  const runs: Block[][] = [];
  let page: Block[] = [];
  const flush = () => {
    if (page.length > 1 && page.some((b) => b.kind !== 'callout')) runs.push(page);
    else runs.push(...page.map((b) => [b]));
    page = [];
  };
  for (const b of items) {
    if (PAGE_KINDS.has(b.kind)) {
      page.push(b);
    } else {
      flush();
      runs.push([b]);
    }
  }
  flush();
  return runs;
}

/** A cell this short (a time, a name, a count) is never broken over two lines. */
export const SHORT_CELL = 12;

/** Per column: whether every cell, and the label, fits on one short line. */
export function shortColumns(table: Pick<TableBlock, 'columns' | 'rows'>): boolean[] {
  return table.columns.map(
    (c, j) =>
      !!c.numeric || table.rows.every((r) => formatCell(r[j] ?? null, c).length <= SHORT_CELL)
  );
}

/** Attachments an image block already draws: the message's file list leaves them out. */
export function attachmentsOutsideBlocks(
  attachments: readonly Attachment[] | undefined,
  set: BlockSet | null
): Attachment[] {
  const list = attachments ?? [];
  if (!set) return [...list];
  const drawn = new Set(set.items.flatMap((b) => (b.kind === 'image' ? [b.file.path] : [])));
  return list.filter((a) => !drawn.has(a.path));
}

/* ---- Answers ----------------------------------------------------------------- */

/**
 * What the user said after these blocks, if anything: their next message in
 * the chat. Once they have answered, a choice shows which one (when the
 * words match) and nothing on it sends again.
 */
export function answerAfter(
  messages: readonly Pick<AgentMessage, 'id' | 'kind' | 'text'>[],
  messageId: string
): string | null {
  const at = messages.findIndex((m) => m.id === messageId);
  if (at < 0) return null;
  for (let i = at + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.kind === 'user') return m.text;
  }
  return null;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Which reply of these the answer was, if it was one of them. */
export function pickedReply(replies: readonly string[], answer: string | null): number {
  if (answer == null) return -1;
  const a = norm(answer);
  return replies.findIndex((r) => norm(r) === a);
}

export type FormValues = Record<string, string>;

/** Fields still needing an answer. */
export function missingFields(block: FormBlock, values: FormValues): string[] {
  return block.fields.filter((f) => f.required && !(values[f.id] ?? '').trim()).map((f) => f.id);
}

/** A number field holds a number (blank is fine when it isn't required). */
export function badNumbers(block: FormBlock, values: FormValues): string[] {
  return block.fields
    .filter((f) => f.type === 'number')
    .filter((f) => {
      const v = (values[f.id] ?? '').trim().replace(/,/g, '');
      return v !== '' && !Number.isFinite(Number(v));
    })
    .map((f) => f.id);
}

/**
 * The user's reply to a form: one line per answered field, in the form's
 * order, under its title. Plain words, so the agent reads it like anything
 * else the user wrote.
 */
export function formReply(block: FormBlock, values: FormValues): string {
  const lines = block.fields.flatMap((f) => {
    const v = (values[f.id] ?? '').trim();
    if (!v) return [];
    return [f.type === 'long_text' && v.includes('\n') ? `${f.label}:\n${v}` : `${f.label}: ${v}`];
  });
  return [block.title?.trim(), ...lines].filter(Boolean).join('\n');
}

/* ---- Numbers ----------------------------------------------------------------- */

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function withCommas(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A number as people read it: in full under 10,000 (1,284; 3.5), compact
 * above (12.9K, 4.2M, 1.1B). `full` keeps every digit (tables, tooltips).
 */
export function formatNumber(n: number, full = false, compact = false): string {
  if (!Number.isFinite(n)) return '–';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (!full && (a >= 10_000 || (compact && a >= 1000))) {
    const [div, unit] =
      a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
    const v = a / div;
    return `${sign}${trimZeros(v.toFixed(v >= 100 ? 0 : 1))}${unit}`;
  }
  const digits = a >= 100 ? 0 : a >= 1 ? 2 : 3;
  // In full (a table, a tooltip) a fraction keeps both places, so a column
  // of amounts lines up: 1,890.50 under 4,200, never 1,890.5.
  const fixed =
    full && a >= 1 && !Number.isInteger(a)
      ? a.toFixed(2)
      : trimZeros(a.toFixed(full && a >= 100 ? 0 : digits));
  const [int = '0', frac] = fixed.split('.');
  return `${sign}${withCommas(int)}${frac ? `.${frac}` : ''}`;
}

/** With the block's units: "$12.9K", "42%", "120 ms". */
export function formatValue(
  n: number | null | undefined,
  units: { prefix?: string; suffix?: string } = {},
  full = false,
  compact = false
): string {
  if (n == null || !Number.isFinite(n)) return '–';
  const body = formatNumber(n, full, compact);
  const neg = body.startsWith('-');
  const digits = neg ? body.slice(1) : body;
  return `${neg ? '−' : ''}${units.prefix ?? ''}${digits}${units.suffix ?? ''}`;
}

export type Direction = 'up' | 'down' | 'flat';

/** A metric's delta as shown, which way it went, and whether that is good. */
export function metricDelta(
  m: Metric
): { text: string; direction: Direction; tone: 'good' | 'bad' | 'neutral' } | null {
  if (m.delta == null || m.delta === '') return null;
  let text: string;
  let direction: Direction;
  if (typeof m.delta === 'number') {
    direction = m.delta > 0 ? 'up' : m.delta < 0 ? 'down' : 'flat';
    const v = formatValue(Math.abs(m.delta), { prefix: m.prefix, suffix: m.suffix });
    text = `${m.delta > 0 ? '+' : m.delta < 0 ? '−' : ''}${v}`;
  } else {
    text = m.delta.trim();
    direction = /^[+↑▲]/.test(text) ? 'up' : /^[-−–↓▼]/.test(text) ? 'down' : 'flat';
  }
  const good = m.good ?? 'up';
  const tone = direction === 'flat' ? 'neutral' : direction === good ? 'good' : 'bad';
  return { text, direction, tone };
}

export function metricValue(m: Metric): string {
  return typeof m.value === 'number'
    ? formatValue(m.value, { prefix: m.prefix, suffix: m.suffix })
    : `${m.prefix ?? ''}${m.value}${m.suffix ?? ''}`;
}

/* ---- Tables ------------------------------------------------------------------ */

export type SortDir = 'asc' | 'desc';

/** Rows sorted by one column; blanks last either way, ties keep their order. */
export function sortRows(rows: readonly Cell[][], col: number, dir: SortDir): Cell[][] {
  const indexed = rows.map((r, i) => [r, i] as const);
  const blank = (c: Cell) => c == null || c === '';
  indexed.sort(([a, ai], [b, bi]) => {
    const x = a[col] ?? null;
    const y = b[col] ?? null;
    if (blank(x) && blank(y)) return ai - bi;
    if (blank(x)) return 1;
    if (blank(y)) return -1;
    let c: number;
    if (typeof x === 'number' && typeof y === 'number') c = x - y;
    else c = String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
    if (c === 0) return ai - bi;
    return dir === 'asc' ? c : -c;
  });
  return indexed.map(([r]) => r);
}

export function formatCell(cell: Cell, column: TableColumn | undefined): string {
  if (cell == null || cell === '') return '';
  if (typeof cell === 'number') return formatValue(cell, column ?? {}, true);
  return cell;
}

/* ---- Charts ------------------------------------------------------------------ */

/** Clean ticks covering [min, max]: 0 / 5 / 10 / 15, never 0 / 3.7 / 7.4. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    if (min === 0) return [0, 1];
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  // The finest clean step that keeps to about `count` intervals (one more is
  // fine): 0–47 is 0/10/…/50, not 0/20/40/60.
  const steps = [0.5, 1, 2, 2.5, 5, 10, 20].map((k) => k * mag);
  const step =
    steps.find((st) => Math.ceil(max / st) - Math.floor(min / st) <= count + 1) ?? 20 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tick {
  value: number;
  y: number;
  label: string;
}

export interface XLabel {
  index: number;
  x: number;
  label: string;
}

export interface SeriesPath {
  slot: number;
  name: string;
  /** The line, null values breaking it. */
  line: string;
  /** The wash under it (area charts, and a single-series line). */
  area?: string;
  /** Each value's point, null where there is none. */
  points: ({ x: number; y: number; value: number } | null)[];
}

export interface BarRect {
  slot: number;
  series: number;
  index: number;
  value: number;
  /** A rect whose data end is rounded and whose baseline end is square. */
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Slice {
  slot: number;
  index: number;
  label: string;
  value: number;
  share: number;
  path: string;
  /** Where its share label sits. */
  labelAt: { x: number; y: number };
}

export interface CartesianModel {
  type: 'cartesian';
  plot: Box;
  ticks: Tick[];
  xLabels: XLabel[];
  /** Each category's centre, for the hover column. */
  xs: number[];
  /** The step between categories. */
  band: number;
  lines: SeriesPath[];
  bars: BarRect[];
  baseline: number;
}

export interface PieModel {
  type: 'pie';
  cx: number;
  cy: number;
  r: number;
  inner: number;
  slices: Slice[];
  total: number;
}

export type ChartModel = CartesianModel | PieModel;

/** About how wide a label is at the axis size (11px), without measuring. */
export const charWidth = (s: string) => s.length * 6.2;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The slot (1-based) a series takes: its place in the block, never cycled. */
export const slotOf = (i: number) => Math.min(i, SERIES_SLOTS - 1) + 1;

function valuesOf(block: ChartBlock): number[] {
  return block.series.flatMap((s) =>
    s.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  );
}

/** A bar from `base` to `top` (y in px), its data end rounded by `radius`. */
export function barPath(x: number, w: number, base: number, top: number, radius = 4): string {
  const up = top <= base;
  const h = Math.abs(base - top);
  const r = Math.min(radius, w / 2, h);
  if (h <= 0) return '';
  if (up) {
    return `M${r2(x)},${r2(base)}V${r2(top + r)}Q${r2(x)},${r2(top)} ${r2(x + r)},${r2(top)}H${r2(x + w - r)}Q${r2(x + w)},${r2(top)} ${r2(x + w)},${r2(top + r)}V${r2(base)}Z`;
  }
  return `M${r2(x)},${r2(base)}V${r2(top - r)}Q${r2(x)},${r2(top)} ${r2(x + r)},${r2(top)}H${r2(x + w - r)}Q${r2(x + w)},${r2(top)} ${r2(x + w)},${r2(top - r)}V${r2(base)}Z`;
}

/** A square-ended segment (inside a stack). */
function rectPath(x: number, w: number, y0: number, y1: number): string {
  const top = Math.min(y0, y1);
  const bot = Math.max(y0, y1);
  if (bot - top <= 0) return '';
  return `M${r2(x)},${r2(bot)}V${r2(top)}H${r2(x + w)}V${r2(bot)}Z`;
}

/**
 * Everything a chart draws, in pixels, for a box of `width` × `height`. The
 * desk (SVG) and the phone (react-native-svg) draw these paths as they are.
 */
export function chartModel(block: ChartBlock, width: number, height: number): ChartModel {
  if (block.chart === 'pie' || block.chart === 'donut') return pieModel(block, width, height);
  return cartesianModel(block, width, height);
}

function pieModel(block: ChartBlock, width: number, height: number): PieModel {
  const size = Math.min(width, height);
  const r = size / 2 - 2;
  const cx = width / 2;
  const cy = height / 2;
  const inner = block.chart === 'donut' ? r * 0.62 : 0;
  const values = (block.series[0]?.values ?? []).map((v) =>
    typeof v === 'number' && v > 0 ? v : 0
  );
  const total = values.reduce((a, b) => a + b, 0);
  const slices: Slice[] = [];
  let angle = -Math.PI / 2;
  values.forEach((v, index) => {
    if (v <= 0 || total <= 0) return;
    const share = v / total;
    const sweep = share * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const mid = (a0 + a1) / 2;
    const lr = inner ? (r + inner) / 2 : r * 0.62;
    slices.push({
      slot: slotOf(index),
      index,
      label: block.labels[index] ?? '',
      value: v,
      share,
      path: arcPath(cx, cy, r, inner, a0, a1),
      labelAt: { x: r2(cx + Math.cos(mid) * lr), y: r2(cy + Math.sin(mid) * lr) },
    });
  });
  return { type: 'pie', cx, cy, r, inner, slices, total };
}

/** One slice (or ring segment); a whole circle when it is the only one. */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  inner: number,
  a0: number,
  a1: number
): string {
  const full = a1 - a0 >= Math.PI * 2 - 1e-6;
  const pt = (rad: number, a: number) =>
    `${r2(cx + Math.cos(a) * rad)},${r2(cy + Math.sin(a) * rad)}`;
  if (full) {
    const mid = a0 + Math.PI;
    const outer = `M${pt(r, a0)}A${r2(r)},${r2(r)} 0 1 1 ${pt(r, mid)}A${r2(r)},${r2(r)} 0 1 1 ${pt(r, a0)}Z`;
    if (!inner) return outer;
    return `${outer}M${pt(inner, a0)}A${r2(inner)},${r2(inner)} 0 1 0 ${pt(inner, mid)}A${r2(inner)},${r2(inner)} 0 1 0 ${pt(inner, a0)}Z`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  if (!inner) {
    return `M${r2(cx)},${r2(cy)}L${pt(r, a0)}A${r2(r)},${r2(r)} 0 ${large} 1 ${pt(r, a1)}Z`;
  }
  return `M${pt(r, a0)}A${r2(r)},${r2(r)} 0 ${large} 1 ${pt(r, a1)}L${pt(inner, a1)}A${r2(inner)},${r2(inner)} 0 ${large} 0 ${pt(inner, a0)}Z`;
}

function cartesianModel(block: ChartBlock, width: number, height: number): CartesianModel {
  const spark = block.chart === 'sparkline';
  const stacked = !!block.stacked && (block.chart === 'bar' || block.chart === 'area');
  const n = Math.max(block.labels.length, ...block.series.map((s) => s.values.length), 1);
  const units = { prefix: block.prefix, suffix: block.suffix };

  // The value domain: stacks add up, bars always include zero.
  let lo: number;
  let hi: number;
  if (stacked) {
    lo = 0;
    hi = 0;
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of block.series) {
        const v = s.values[i];
        if (typeof v !== 'number') continue;
        if (v >= 0) pos += v;
        else neg += v;
      }
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
  } else {
    const vs = valuesOf(block);
    lo = vs.length ? Math.min(...vs) : 0;
    hi = vs.length ? Math.max(...vs) : 1;
  }
  if (block.chart === 'bar' || block.chart === 'area') {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const ticks0 = spark ? [lo, hi === lo ? lo + 1 : hi] : niceTicks(lo, hi, height < 160 ? 3 : 4);
  const dLo = ticks0[0];
  const dHi = ticks0[ticks0.length - 1];

  // One style per axis: compact throughout once it reaches 10,000.
  const compact = Math.max(...ticks0.map(Math.abs)) >= 10_000;
  const tickLabels = ticks0.map((t) => formatValue(t, units, false, compact));
  const left = spark ? 2 : Math.ceil(Math.max(...tickLabels.map(charWidth))) + 10;
  const bottom = spark ? 2 : 22;
  const top = spark ? 4 : 8;
  const right = spark ? 4 : 8;
  const plot: Box = {
    x: left,
    y: top,
    w: Math.max(10, width - left - right),
    h: Math.max(10, height - top - bottom),
  };
  const y = (v: number) =>
    dHi === dLo ? plot.y + plot.h / 2 : plot.y + plot.h - ((v - dLo) / (dHi - dLo)) * plot.h;

  const isBar = block.chart === 'bar';
  const band = isBar ? plot.w / n : n > 1 ? plot.w / (n - 1) : plot.w;
  const xs = Array.from({ length: n }, (_, i) =>
    r2(isBar ? plot.x + band * (i + 0.5) : n > 1 ? plot.x + band * i : plot.x + plot.w / 2)
  );

  const ticks: Tick[] = spark
    ? []
    : ticks0.map((value, i) => ({ value, y: r2(y(value)), label: tickLabels[i] }));

  // X labels: as many as fit side by side, always the first and the last.
  const xLabels: XLabel[] = [];
  if (!spark && block.labels.length) {
    const widest = Math.max(...block.labels.map(charWidth)) + 12;
    const every = Math.max(1, Math.ceil((widest * n) / plot.w));
    for (let i = 0; i < n; i += every) {
      xLabels.push({ index: i, x: xs[i], label: block.labels[i] ?? '' });
    }
    const last = n - 1;
    if (xLabels[xLabels.length - 1]?.index !== last && last > 0) {
      const prev = xLabels[xLabels.length - 1];
      if (prev && xs[last] - prev.x < widest) xLabels.pop();
      xLabels.push({ index: last, x: xs[last], label: block.labels[last] ?? '' });
    }
  }

  const baseline = r2(y(Math.max(dLo, Math.min(0, dHi))));
  const lines: SeriesPath[] = [];
  const bars: BarRect[] = [];

  if (isBar) {
    const count = block.series.length;
    const gap = 2;
    if (stacked) {
      const w = Math.min(24, band * 0.6);
      for (let i = 0; i < n; i++) {
        let pos = 0;
        let neg = 0;
        // The last non-zero segment on each side carries the rounded end.
        const lastPos = block.series.reduce((k, s, si) => ((s.values[i] ?? 0) > 0 ? si : k), -1);
        const lastNeg = block.series.reduce((k, s, si) => ((s.values[i] ?? 0) < 0 ? si : k), -1);
        block.series.forEach((s, si) => {
          const v = s.values[i];
          if (typeof v !== 'number' || v === 0) return;
          const from = v > 0 ? pos : neg;
          const to = from + v;
          if (v > 0) pos = to;
          else neg = to;
          const x = xs[i] - w / 2;
          let y0 = y(from);
          const y1 = y(to);
          // The surface gap between touching segments.
          if (from !== 0) y0 += v > 0 ? -gap / 2 : gap / 2;
          const end = v > 0 ? si === lastPos : si === lastNeg;
          const path = end ? barPath(x, w, y0, y1) : rectPath(x, w, y0, y1);
          if (!path) return;
          bars.push({
            slot: slotOf(si),
            series: si,
            index: i,
            value: v,
            path,
            x: r2(x),
            y: r2(Math.min(y0, y1)),
            w: r2(w),
            h: r2(Math.abs(y1 - y0)),
          });
        });
      }
    } else {
      const each = Math.max(2, Math.min(24, (band * 0.72 - gap * (count - 1)) / count));
      const group = each * count + gap * (count - 1);
      for (let i = 0; i < n; i++) {
        block.series.forEach((s, si) => {
          const v = s.values[i];
          if (typeof v !== 'number') return;
          const x = xs[i] - group / 2 + si * (each + gap);
          const path = barPath(x, each, baseline, y(v));
          bars.push({
            slot: slotOf(si),
            series: si,
            index: i,
            value: v,
            path,
            x: r2(x),
            y: r2(Math.min(baseline, y(v))),
            w: r2(each),
            h: r2(Math.abs(y(v) - baseline)),
          });
        });
      }
    }
  } else {
    const cum = new Array<number>(n).fill(0);
    block.series.forEach((s, si) => {
      const points = Array.from({ length: n }, (_, i) => {
        const v = s.values[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        const at = stacked ? cum[i] + v : v;
        return { x: xs[i], y: r2(y(at)), value: v };
      });
      const prevCum = [...cum];
      if (stacked) points.forEach((p, i) => p && (cum[i] = cum[i] + p.value));
      let line = '';
      let pen = false;
      points.forEach((p) => {
        if (!p) {
          pen = false;
          return;
        }
        line += `${pen ? 'L' : 'M'}${p.x},${p.y}`;
        pen = true;
      });
      let area: string | undefined;
      const wash = block.chart === 'area' || (block.chart === 'line' && block.series.length === 1);
      if (wash) {
        // One wash per run of points, down to the stack below (or the baseline).
        const runs: { x: number; y: number; i: number }[][] = [];
        let run: { x: number; y: number; i: number }[] = [];
        points.forEach((p, i) => {
          if (p) run.push({ ...p, i });
          else if (run.length) {
            runs.push(run);
            run = [];
          }
        });
        if (run.length) runs.push(run);
        area = runs
          .filter((r) => r.length > 1)
          .map((r) => {
            const topEdge = r.map((p, k) => `${k ? 'L' : 'M'}${p.x},${p.y}`).join('');
            const under = [...r]
              .reverse()
              .map((p) => `L${p.x},${r2(stacked ? y(prevCum[p.i]) : baseline)}`)
              .join('');
            return `${topEdge}${under}Z`;
          })
          .join('');
        if (!area) area = undefined;
      }
      lines.push({ slot: slotOf(si), name: s.name, line, area, points });
    });
  }

  return { type: 'cartesian', plot, ticks, xLabels, xs, band, lines, bars, baseline };
}

/** The category under a pointer at `x` (px in the chart's box). */
export function indexAt(model: CartesianModel, x: number): number {
  let best = 0;
  let dist = Infinity;
  model.xs.forEach((cx, i) => {
    const d = Math.abs(cx - x);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}

/** A legend is drawn for two or more series (a pie's slices are its series). */
export function legendEntries(block: ChartBlock): { slot: number; name: string }[] {
  if (block.chart === 'pie' || block.chart === 'donut') {
    return block.labels.map((name, i) => ({ slot: slotOf(i), name }));
  }
  if (block.series.length < 2) return [];
  return block.series.map((s, i) => ({ slot: slotOf(i), name: s.name }));
}

/** The tooltip's lines for one category. */
export function tooltipAt(
  block: ChartBlock,
  index: number
): { title: string; rows: { slot: number; name: string; value: string }[] } {
  const units = { prefix: block.prefix, suffix: block.suffix };
  return {
    title: block.labels[index] ?? '',
    rows: block.series.map((s, i) => ({
      slot: slotOf(i),
      name: s.name,
      value: formatValue(s.values[index] ?? null, units, true),
    })),
  };
}

/** Whether the chart has anything to draw. */
export function chartHasData(block: ChartBlock): boolean {
  const vs = valuesOf(block);
  if (block.chart === 'pie' || block.chart === 'donut') return vs.some((v) => v > 0);
  return vs.length > 0;
}

/** A one-line accessible name: what it shows, and its range. */
export function chartLabel(block: ChartBlock): string {
  const what = block.title?.trim() || block.series.map((s) => s.name).join(', ');
  const kind = block.chart === 'sparkline' ? 'trend' : `${block.chart} chart`;
  const first = block.labels[0];
  const last = block.labels[block.labels.length - 1];
  const span = first && last && first !== last ? `, ${first} to ${last}` : '';
  return `${what} (${kind}${span})`;
}

/** At most this many points read one by one; past it, a series is summed up. */
const SAY_EACH = 8;

/**
 * What a chart shows, in words, for a screen reader: the picture alone told
 * VoiceOver only its title. A pie says each slice and its share; a series of
 * a few points says each; a longer one says where it started and ended, and
 * its low and high.
 */
export function chartSummary(block: ChartBlock): string {
  const units = { prefix: block.prefix, suffix: block.suffix };
  const say = (v: number) => formatValue(v, units, true);
  if (block.chart === 'pie' || block.chart === 'donut') {
    const values = block.series[0]?.values ?? [];
    const slices = block.labels
      .map((label, i) => ({ label, v: values[i] }))
      .filter((s): s is { label: string; v: number } => typeof s.v === 'number' && s.v > 0);
    const total = slices.reduce((a, s) => a + s.v, 0);
    const shown = slices.slice(0, SAY_EACH);
    const parts = shown.map(
      (s) => `${s.label} ${say(s.v)}${total > 0 ? `, ${Math.round((s.v / total) * 100)}%` : ''}`
    );
    const more = slices.length - shown.length;
    if (more > 0) parts.push(`and ${more} more`);
    return `${parts.join('; ')}. Total ${say(total)}.`;
  }
  const lines = block.series.map((s) => {
    const points = block.labels
      .map((label, i) => ({ label, v: s.values[i] }))
      .filter((p): p is { label: string; v: number } => typeof p.v === 'number');
    if (!points.length) return '';
    const name = block.series.length > 1 || block.chart !== 'sparkline' ? `${s.name}: ` : '';
    if (points.length <= SAY_EACH) {
      return name + points.map((p) => (p.label ? `${p.label} ${say(p.v)}` : say(p.v))).join(', ');
    }
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const low = points.reduce((a, p) => (p.v < a.v ? p : a));
    const high = points.reduce((a, p) => (p.v > a.v ? p : a));
    const at = (p: { label: string; v: number }) => (p.label ? ` (${p.label})` : '');
    return (
      `${name}from ${say(first.v)}${at(first)} to ${say(last.v)}${at(last)}, ` +
      `low ${say(low.v)}${at(low)}, high ${say(high.v)}${at(high)}`
    );
  });
  return lines.filter(Boolean).join('. ') + '.';
}

/** The host a link goes to, without "www.". */
export function domainOf(url: string): string {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(url.trim());
  return (m?.[1] ?? '').replace(/^www\./i, '').toLowerCase();
}
