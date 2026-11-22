/**
 * `--load`: the owner's real team at the size it is (21 Nov 2026), for
 * measuring how the phone opens under it: 42 agents whose overview is ~190 KB
 * (routines and usage make most of it), a few hundred lines in each chat, and
 * `/dev/burst?n=1180`, which journals what the team said while the phone was
 * away. Sizes were read off that team; the words are made up.
 *
 * - `/dev/burst?n=<lines>` says `n` lines across the team (a status change with
 *   each, as a turn's steps do), 1 in 12 of them markdown.
 * - `/dev/stream?rate=<lines a minute>&drafts=<replies streaming>` keeps it
 *   going until `/dev/stream?rate=0`.
 */

import type { Agent, AgentMessage } from '@shipstudio/companion-protocol';

type Base = (id: string, name: string, role: string, color: string, extra: Partial<Agent>) => Agent;

const COLORS = ['orange', 'red', 'pink', 'brown', 'gray', 'purple', 'teal', 'green', 'blue'];
const WORDS =
  'checked the build and the tests pass on both themes so the branch is ready for the next merge after one more look at the sidebar width'.split(
    ' '
  );

/** `chars` of plain words, the same for the same `seed`. */
const prose = (chars: number, seed: number) => {
  let out = '';
  for (let i = seed; out.length < chars; i++) out += `${WORDS[(i * 7) % WORDS.length]} `;
  return out.trim();
};

const markdown = (seed: number) =>
  `## ${prose(24, seed)}\n\n- **${prose(30, seed + 1)}**\n- \`${prose(18, seed + 2)}\`\n- ${prose(90, seed + 3)}\n\n| What | Before | After |\n| --- | --- | --- |\n| ${prose(14, seed)} | 46 ms | 3 ms |\n\n\`\`\`ts\n${prose(120, seed + 4)}\n\`\`\``;

const line = (agentId: string, i: number, ts: number): AgentMessage =>
  ({
    id: `${agentId}_l${String(i).padStart(5, '0')}`,
    agentId,
    conversation: 'first',
    ts,
    kind: i % 6 === 0 ? 'user' : i % 5 === 0 ? 'note' : 'agent',
    text: i % 12 === 1 ? markdown(i) : prose(i % 4 === 0 ? 900 : 260, i),
  }) as AgentMessage;

export const LOAD_AGENTS = 42;
const LINES = 400;

export function addLoadAccount(
  agents: Agent[],
  messages: Map<string, AgentMessage[]>,
  base: Base,
  now: number
) {
  for (let n = agents.length; n < LOAD_AGENTS; n++) {
    const id = `load${n}`;
    agents.push(
      base(id, `Agent ${n}`, prose(120, n), COLORS[n % COLORS.length], {
        lastActivityAt: now - n * 60_000,
        preview: prose(90, n),
        unread: n % 3 === 0 ? 2 : 0,
      })
    );
    messages.set(id, []);
  }
  agents.forEach((a, n) => {
    const had = messages.get(a.id) ?? [];
    const old = Array.from({ length: LINES }, (_, i) =>
      line(a.id, i, now - 86_400_000 + i * 120_000 + n)
    );
    messages.set(
      a.id,
      [...old, ...had].sort((x, y) => x.ts - y.ts)
    );
    // What fills the real overview: each agent's routines and its usage.
    Object.assign(a, {
      checkIns: Array.from({ length: 3 }, (_, i) => ({
        id: `${a.id}_r${i}`,
        prompt: prose(700, n + i),
        every: 'weekdays at 09:00',
        kind: 'daily',
        paused: i === 2,
        nextRunAt: now + 3_600_000 * (i + 1),
      })),
      usage: { note: prose(1200, n) },
      capabilities: { note: prose(600, n) },
    });
  });
}

export interface LoadBus {
  agents: Agent[];
  putMessage(m: AgentMessage): void;
  setStatus(id: string, state: Agent['status']['state'], activity: string | null): void;
  registry(): void;
  draft(agentId: string, id: string, text: string): void;
}

let said = 0;
let timers: ReturnType<typeof setInterval>[] = [];

/** One line from the next agent, with the status and the team event the Mac sends beside it. */
function sayOne(bus: LoadBus, registry: boolean) {
  const a = bus.agents[said % bus.agents.length];
  const m = line(a.id, 100_000 + said, Date.now());
  said++;
  bus.setStatus(a.id, 'working', prose(40, said));
  bus.putMessage(m);
  a.lastActivityAt = m.ts;
  a.preview = prose(80, said);
  if (registry) bus.registry();
}

/** The `--load` drivers (`/dev/burst`, `/dev/stream`); null for any other path. */
export function loadAction(bus: LoadBus, url: URL): string | null {
  if (url.pathname === '/dev/burst') {
    const n = Number(url.searchParams.get('n') ?? 1180);
    for (let i = 0; i < n; i++) sayOne(bus, i % 2 === 0);
    return `said ${n}`;
  }
  if (url.pathname === '/dev/stream') {
    timers.forEach(clearInterval);
    timers = [];
    const rate = Number(url.searchParams.get('rate') ?? 0);
    const drafts = Number(url.searchParams.get('drafts') ?? 0);
    if (rate > 0) timers.push(setInterval(() => sayOne(bus, true), 60_000 / rate));
    for (let d = 0; d < drafts; d++) {
      const a = bus.agents[(d * 5) % bus.agents.length];
      let text = '';
      let turn = 0;
      timers.push(
        setInterval(() => {
          if (text.length > 2400) {
            text = '';
            turn++;
          }
          text += `${prose(12, text.length)} `;
          bus.draft(a.id, `${a.id}_d${turn}`, text);
        }, 100)
      );
    }
    return `streaming ${rate}/min, ${drafts} replies`;
  }
  return null;
}
