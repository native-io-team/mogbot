/**
 * Agents under load: 40 agents, a 2,000-line Chief chat (markdown, code,
 * result cards, approvals, copy cards, 60-step timelines, images), and a
 * driver for live status / message / registry / draft events.
 *
 * The perf fixture behind `scripts/perf-agents.mjs` (see docs/ui-harness.md,
 * "Measuring performance"). The chat is served in 150-line pages exactly as
 * `agents_messages` serves them, and every block of 20 lines carries one of
 * each kind of row the chat renders.
 *
 * The driver exists only on this scenario's page and is off until started,
 * so idle can be measured on the same page:
 *   window.__stress.start({ rate: 10, open: true })  // status events per second
 *   window.__stress.stop()
 *   window.__stress.stream({ blocks: 12, every: 40 }) // a long reply, as drafts
 *   window.__stress.counts                            // what was sent
 */

import { emit } from '@tauri-apps/api/event';
import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, agent, now, overview } from './agents';

const COLORS = [
  'white',
  'teal',
  'blue',
  'orange',
  'green',
  'purple',
  'pink',
  'amber',
  'red',
  'gray',
];
const KINDS = ['read', 'edit', 'search', 'web', 'command', 'message', 'plan', 'tool'];

const STRESS_TEAM = [
  { ...TEAM[0], id: 'chief' },
  ...Array.from({ length: 39 }, (_, i) =>
    agent(
      `a${i}`,
      `Agent ${String(i + 1).padStart(2, '0')} ${['Finance', 'Research', 'Travel', 'Inbox', 'Acme Site'][i % 5]}`,
      {
        color: COLORS[i % COLORS.length],
        shape: i % 8,
        role: `Does the ${i}th kind of thing, carefully`,
        preview: `Latest from agent ${i}: the report is ready and the numbers check out.`,
        minutesAgo: 5 + i * 13,
        unread: i % 7 === 0 ? 2 : 0,
        pendingApprovals: i % 11 === 0 ? 1 : 0,
      }
    )
  ),
];

const IMG = (name: string) => ({
  name,
  path: 'attachments/m-att1/Hero crop.jpg',
  mime: 'image/jpeg',
  size: 27_238,
});

const work = (t0: number, n: number, ended = true) => ({
  startedAt: t0,
  ...(ended ? { endedAt: t0 + n * 4000 } : {}),
  stepCount: n,
  fileCount: 3,
  files: ['src/a.tsx', 'src/b.css', 'src/c.ts'],
  steps: Array.from({ length: n }, (_, s) => ({
    at: t0 + s * 4000,
    kind: KINDS[s % KINDS.length],
    label: `Step ${s + 1}: ${['Read', 'Edited', 'Searched for', 'Browsed', 'Ran'][s % 5]} thing-${s}.tsx`,
    ...(s % 20 === 7 ? { image: IMG(`shot-${s}.jpg`) } : {}),
    ...(s % 17 === 3 ? { outcome: 'failed' } : {}),
  })),
});

const MD = (i: number) =>
  [
    `### Update ${i}`,
    `Here is what I found about **item ${i}**, with \`inline code\`, a [link](https://example.com/${i}) and a path ~/ShipStudio/acme/src/page-${i}.tsx.`,
    '',
    '- first point, with *emphasis*',
    '- second point, with `code`',
    '- third point',
    '',
    '| Client | Due | Paid |',
    '| --- | --- | --- |',
    `| Acme | $${i * 10} | yes |`,
    `| Globex | $${i * 7} | no |`,
    '',
    '> A quoted line from the brief.',
  ].join('\n');

const CODE = (i: number) =>
  `Here is the fix:\n\n\`\`\`ts\nexport function price${i}(n: number) {\n  const base = n * ${i};\n  return base > 100 ? base * 0.9 : base;\n}\n\`\`\`\n\nAnd the CSS:\n\n\`\`\`css\n.card-${i} { display: grid; gap: 24px; }\n\`\`\``;

const RESULT = (i: number) => ({
  id: `res-${i}`,
  version: 1,
  title: `Report ${i}`,
  summary: `Everything about item ${i} on one page, grouped by client.`,
  items: [{ kind: 'link', url: `https://docs.example.com/${i}`, label: 'Source sheet' }],
  checked: ['Totals match the bank export'],
  notVerified: ['Two EUR invoices use today’s rate'],
});

const COPY = {
  id: 'copy-1',
  path: '/harness/copies/acme',
  base: 'main',
  createdAt: now - 60 * MIN,
};

// `?lines=5000` for the long-chat measurements (scripts/perf-agents.mjs --lines).
const N =
  (typeof window !== 'undefined' &&
    Number(new URLSearchParams(window.location.search).get('lines'))) ||
  2000;
const T0 = now - N * 3 * MIN;
const chiefLine = (i: number): Record<string, unknown> => {
  const base = { id: `s${i}`, agentId: 'chief', ts: T0 + i * 3 * MIN };
  const r = i % 20;
  if (r === 0 || r === 10)
    return { ...base, kind: 'user', text: `Question ${i}: can you check item ${i}?` };
  if (r === 1) return { ...base, kind: 'agent', text: MD(i), work: work(base.ts - 240_000, 60) };
  if (r === 2) return { ...base, kind: 'agent', text: CODE(i) };
  if (r === 3)
    return {
      ...base,
      kind: 'agent',
      text: RESULT(i).summary,
      result: RESULT(i),
      work: work(base.ts - 240_000, 60),
    };
  if (r === 4)
    return {
      ...base,
      kind: 'approval',
      text: '',
      approval: {
        requestId: `req-${i}`,
        title: 'Run a command',
        detail: `npm run build -- --item ${i}`,
        status: i % 40 === 4 ? 'denied' : 'allowed',
        tool: 'Bash',
      },
    };
  if (r === 5)
    return {
      ...base,
      kind: 'changes',
      text: 'Changed 3 files in a copy of acme-marketing',
      changes: {
        project: '/harness/acme-marketing',
        from: 'base-tree',
        to: 'copy-tree',
        files: [
          { path: 'src/a.tsx', status: 'modified', added: 10, removed: 2 },
          { path: 'src/b.css', status: 'added', added: 30 },
          { path: 'src/c.ts', status: 'deleted', removed: 12 },
        ],
        fileCount: 3,
        added: 40,
        removed: 14,
        copy: COPY,
      },
    };
  if (r === 6)
    return {
      ...base,
      kind: 'user',
      text: 'Screenshots attached',
      attachments: [IMG('a.jpg'), IMG('b.jpg')],
    };
  if (r === 7)
    return {
      ...base,
      kind: 'agent',
      text: 'The hero after the fix.',
      attachments: [IMG('hero.jpg')],
    };
  if (r === 8) return { ...base, kind: 'note', text: 'Allowed automatically: Read package.json' };
  return {
    ...base,
    kind: 'agent',
    text: `Plain reply ${i}. Done — the cards stack below 640px and the footer links resolve. ${'More words here. '.repeat(i % 5)}`,
  };
};

const page = (log: Record<string, unknown>[], args: Record<string, unknown>) => {
  const {
    limit = 150,
    before,
    through,
  } = args as { limit?: number; before?: string; through?: string };
  const end = before ? log.findIndex((m) => m.id === before) : log.length;
  let start = Math.max(0, end - limit);
  const at = through ? log.findIndex((m) => m.id === through) : -1;
  if (at >= 0 && at < start) start = at;
  return log.slice(start, end);
};

// Built on first ask, so the other scenarios' pages never pay for 2,000 lines.
const LOGS: Record<string, Record<string, unknown>[]> = {};
const logFor = (id: string) =>
  (LOGS[id] ??=
    id === 'chief'
      ? Array.from({ length: N }, (_, i) => chiefLine(i))
      : Array.from({ length: 30 }, (_, i) => ({
          id: `${id}-m${i}`,
          agentId: id,
          ts: now - (30 - i) * MIN,
          kind: i % 2 ? 'agent' : 'user',
          text: i % 2 ? MD(i) : `Ask ${i}`,
        })));

const team = STRESS_TEAM.map((a) => ({ ...a }));

declare global {
  interface Window {
    __stress?: {
      start: (o?: { rate?: number; open?: boolean; registryEvery?: number }) => void;
      stop: () => void;
      counts: Record<string, number>;
      stream: (o?: { agentId?: string; blocks?: number; every?: number }) => Promise<number>;
      arrive: (id: string) => void;
    };
  }
}

const counts: Record<string, number> = { status: 0, message: 0, registry: 0, draft: 0 };
let timer: number | null = null;
let tick = 0;
const steps: Record<string, number> = {};
const BUSY = ['a1', 'a2', 'a3', 'a5', 'a8', 'a13'];

const isThisScenario =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('scenario') === 'agents-stress';

if (isThisScenario) {
  window.__stress = {
    counts,
    // One finished reply with its timeline landing in the open chat.
    arrive: (id) => {
      const m = {
        id,
        agentId: 'chief',
        ts: Date.now(),
        kind: 'agent',
        text: MD(7),
        work: work(Date.now() - 60_000, 60),
      };
      logFor('chief').push(m);
      counts.message++;
      void emit('agents://message', m);
    },
    // A reply streamed the way the backend sends it: the whole text so far every `every` ms.
    stream: ({ agentId = 'chief', blocks = 12, every = 40 } = {}) =>
      new Promise((resolve) => {
        const full = Array.from({ length: blocks }, (_, i) => (i % 3 === 2 ? CODE(i) : MD(i))).join(
          '\n\n'
        );
        const words = full.match(/\S+\s*/g) ?? [full];
        const id = `draft-${Date.now()}`;
        let i = 0;
        const t = window.setInterval(() => {
          i += 3;
          counts.draft++;
          void emit('agents://draft', { agentId, id, text: words.slice(0, i).join('') });
          if (i >= words.length) {
            clearInterval(t);
            resolve(full.length);
          }
        }, every);
      }),
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    start: ({ rate = 10, open = false, registryEvery = 30 } = {}) => {
      if (timer !== null) clearInterval(timer);
      const ids = open ? [...BUSY, 'chief'] : BUSY;
      timer = window.setInterval(() => {
        tick++;
        const id = ids[tick % ids.length];
        const n = (steps[id] = ((steps[id] ?? 0) % 60) + 1);
        const t0 = Date.now() - n * 4000;
        counts.status++;
        void emit('agents://status', {
          agentId: id,
          status: {
            state: 'working',
            activity: `Running step ${n}`,
            since: t0,
            work: { ...work(t0, n, false), doing: `Running step ${n}` },
          },
        });
        // A finished line in a background chat every ~2s.
        if (tick % (rate * 2) === 0) {
          const bg = BUSY[(tick / (rate * 2)) % BUSY.length];
          const log = logFor(bg);
          const m = {
            id: `${bg}-live${tick}`,
            agentId: bg,
            ts: Date.now(),
            kind: 'agent',
            text: MD(tick),
          };
          log.push(m);
          counts.message++;
          void emit('agents://message', m);
          const row = team.find((a) => a.id === bg);
          if (row) {
            (row as { preview: string | null }).preview = `Live ${tick}`;
            row.lastActivityAt = Date.now();
          }
        }
        // With the chat open, a new line lands in it every ~5s too.
        if (open && tick % (rate * 5) === 0) {
          const m = {
            id: `chief-live${tick}`,
            agentId: 'chief',
            ts: Date.now(),
            kind: 'agent',
            text: MD(tick),
            work: work(Date.now() - 60_000, 60),
          };
          logFor('chief').push(m);
          counts.message++;
          void emit('agents://message', m);
        }
        if (tick % registryEvery === 0) {
          counts.registry++;
          void emit('agents://registry', {});
        }
      }, 1000 / rate);
    },
  };
}

export const agentsStressScenarios: Scenario[] = [
  {
    id: 'agents-stress',
    title: 'Agents — 40 agents, 2,000-line chat, live events (perf)',
    looksRightWhen:
      'Perf fixture. The Chief chat opens on its newest 150 lines; scrolling up pages older ones in. window.__stress.start({rate:10}) drives status events.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat',
    mockEvents: true,
    commands: {
      agents_overview: () => overview(team.map((a) => ({ ...a }))),
      agents_messages: (args: Record<string, unknown>) => page(logFor(String(args.agentId)), args),
    },
  },
];
