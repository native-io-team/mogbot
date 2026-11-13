/**
 * The chat torture set: everything a real chat throws at the renderer at
 * once, and a driver for the event orders a live session produces.
 *
 * - `agents-torture`: three days of lines in the Chief's chat. Very long
 *   prose, a huge code block, a wide table, nested lists, URLs with no
 *   spaces, emoji / RTL / CJK, images as chips, and every kind of card
 *   interleaved (approval pending / allowed / denied / expired receipts,
 *   secure input, a settings change, a result v1 then v2, errors, a stopped
 *   reply, a fresh-start divider).
 * - `agents-torture-empty`: an agent with no lines at all.
 * - `agents-torture-5000`: a 5,000-line chat, paged as the backend pages it.
 *
 * The driver (`window.__torture`, on these pages only) emits events the way
 * the backend would, including the ones it occasionally gets wrong:
 *   __torture.stream({ words: 400, every: 30 })  // a reply growing, then finished
 *   __torture.duplicate()                        // the last line again, twice
 *   __torture.outOfOrder()                       // two lines, the newer one first
 *   __torture.burst(20)                          // twenty lines back to back
 *   __torture.answer()                           // the pending card allowed, in place
 *   __torture.replace()                          // the last reply edited (same id)
 *   __torture.lateDraft()                        // a draft event after its reply
 *   __torture.card()                             // a reply, then an Allow / Deny card
 *
 * Every name, address, number and link here is made up.
 */

import { emit } from '@tauri-apps/api/event';
import type { Scenario } from '../types';
import { AGENTS_TAB, MIN, TEAM, agent, messagesFor, now, overview } from './agents';

const H = 60 * MIN;
const DAY = 24 * H;

let seq = 0;
const line = (kind: string, text: string, ts: number, over: Record<string, unknown> = {}) => ({
  id: `t${++seq}`,
  agentId: 'chief',
  ts,
  kind,
  text,
  ...over,
});

const LONG = Array.from(
  { length: 14 },
  (_, i) =>
    `Paragraph ${i + 1}. The supplier confirmed the revised delivery window for the Larch & Pine spring range, but the freight quote they attached still assumes the old pallet count, so the landed cost per unit is overstated by roughly four percent until they resend it with the corrected figures from the packing list.`
).join('\n\n');

const HUGE_CODE = [
  'Here is the whole migration, so you can read it before it runs:',
  '',
  '```ts',
  ...Array.from(
    { length: 160 },
    (_, i) =>
      `export const step${String(i).padStart(3, '0')} = async (db: Db) => db.exec("UPDATE inventory SET reorder_point = reorder_point + ${i} WHERE sku LIKE 'LP-${i}-%' AND warehouse_id IN (SELECT id FROM warehouses WHERE region = 'north-east-and-borders-overflow')");`
  ),
  '```',
].join('\n');

const WIDE_TABLE = [
  'The comparison you asked for:',
  '',
  '| Supplier | Region | Lead time | MOQ | Unit price | Freight | Duty | Landed | Payment terms | Rating | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| Northwind Textiles Cooperative | Porto, PT | 21 days | 400 | €3.10 | €0.42 | 0% | €3.52 | 30 days net | 4.6 | Organic cotton only, certified |',
  '| Fjordline Ceramics | Bergen, NO | 35 days | 120 | €7.80 | €1.10 | 2.5% | €9.10 | 50% up front | 4.1 | Glaze batches vary noticeably |',
  '| 山田陶器 (Yamada Pottery) | 瀬戸市, JP | 48 days | 60 | ¥1,240 | ¥310 | 3.4% | ¥1,600 | 60 days | 4.8 | Hand-thrown; ships by sea |',
  '| شركة النخيل للتجارة | دبي، الإمارات | 18 days | 1,000 | $1.95 | $0.38 | 5% | $2.45 | LC at sight | 3.9 | Fastest, least flexible |',
].join('\n');

const NESTED = [
  'The plan, in order:',
  '',
  '1. Inventory',
  '   - Count the north warehouse',
  '     - Aisles 1–12 on Monday',
  '       - Flag anything under its reorder point',
  '         - Photograph damaged stock',
  '     - Aisles 13–30 on Tuesday',
  '   - Reconcile against the shop export',
  '2. Pricing',
  '   1. Pull the landed costs above',
  '   2. Re-price anything whose margin fell under 45%',
  '      - Except the clearance line',
  '3. Tell the shop team',
  '   - [x] Draft the note',
  '   - [ ] Send it Friday',
].join('\n');

const NO_SPACES = [
  'Links and paths that never break on their own:',
  '',
  'https://shop.larchandpine.example/collections/spring-range-2027/products/hand-thrown-stoneware-serving-bowl-large-speckled-oat?variant=4419027733&utm_source=newsletter&utm_medium=email&utm_campaign=spring_launch_early_access_vip_segment_b',
  '',
  '~/ShipStudio/larch-and-pine-storefront/src/components/product-detail/variant-picker/__tests__/VariantPickerWithInventoryAwareSwatches.integration.test.tsx',
  '',
  `Token-looking text: ${'a1b2c3d4e5f6'.repeat(18)}`,
  '',
  `And a word that goes on: ${'Donaudampfschifffahrtsgesellschaftskapitän'.repeat(4)}`,
].join('\n');

const SCRIPTS = [
  'Customer replies from this week, in the languages they came in:',
  '',
  '- 🎉🎉🎉 Love the new bowls!!! 🥣✨ 👩🏽‍🍳👨‍👩‍👧‍👦🏳️‍🌈 Ordering three more for my sister 💯',
  '- 商品はとても美しいですが、配送に二週間かかりました。次回はもっと早く届くと嬉しいです。',
  '- 这个碗的颜色和网站上的照片不太一样，可以换货吗？',
  '- המשלוח הגיע שבור. אפשר לקבל החזר כספי? (order #LP-20931)',
  '- الطلب وصل ناقصاً قطعة واحدة، أرجو المساعدة. رقم الطلب LP-20944',
  '- Mixed: the order LP-20977 עדיין לא הגיע, 已经十天了 😕',
].join('\n');

const IMAGES =
  'Here are the photos they sent: <img src="https://cdn.example.com/returns/IMG_4412.jpg"> and ![broken bowl](https://cdn.example.com/returns/IMG_4413.jpg). I haven’t opened either.';

const approval = (status: string, over: Record<string, unknown> = {}) => ({
  requestId: `req-${++seq}`,
  title: 'Send an email',
  detail:
    'To: orders@northwind-textiles.example\nSubject: Revised pallet count for PO-7781\n\nHi Ana, could you resend the freight quote for 14 pallets rather than 18? Thanks, Sam',
  status,
  tool: 'mcp__gmail__send',
  ...over,
});

const SECRET = {
  name: 'shop_admin_token',
  purpose: 'Read last week’s orders from the shop admin to match the returns above.',
  kind: 'api_key',
  fields: [{ label: 'Admin API token', env: 'SHOP_ADMIN_TOKEN' }],
  reference: 'secret:chief/shop_admin_token',
};

const SETTINGS_SUMMARY =
  'Returns: Can now read the shop admin. New rule: “Refunds over €200 need your OK” (an instruction, not enforced).';

const RESULT_V1 = {
  id: 'res-returns',
  version: 1,
  title: 'Returns this week',
  summary:
    'Nine returns this week: six breakages in transit, two wrong colours, one change of mind.',
  items: [
    { kind: 'link', url: 'https://sheets.example.com/d/returns-w44', label: 'Returns sheet' },
  ],
  checked: ['Every return matches an order in the export'],
  notVerified: ['Two photos weren’t opened, so the breakage is the customer’s word'],
};
const RESULT_V2 = {
  ...RESULT_V1,
  version: 2,
  summary:
    'Nine returns this week, grouped by courier: five of the six breakages came through the same depot.',
  checked: ['Every return matches an order in the export', 'Grouped by courier from the labels'],
  changes: 'Grouped by courier; the depot pattern is new',
};

const d0 = now - 2 * DAY - 3 * H;
const d1 = now - DAY - 2 * H;
const d2 = now - 50 * MIN;

/** Three days of the Chief's chat, oldest first. */
const TORTURE: Record<string, unknown>[] = [
  line('user', 'Morning! Can you go through the supplier mess from last week?', d0),
  line('agent', LONG, d0 + 2 * MIN),
  line('user', 'Show me the migration before it runs.', d0 + 10 * MIN),
  line('agent', HUGE_CODE, d0 + 12 * MIN),
  line('approval', '', d0 + 13 * MIN, {
    approval: approval('allowed', {
      title: 'Run a command',
      detail: 'pnpm db:migrate',
      tool: 'Bash',
    }),
  }),
  line('agent', WIDE_TABLE, d0 + 20 * MIN),
  line('approval', '', d0 + 25 * MIN, {
    approval: approval('expired', { expiry: 'moved_on', title: 'Email Fjordline' }),
  }),
  line('approval', '', d0 + 26 * MIN, {
    approval: approval('expired', { expiry: 'no_answer', title: 'Post in #suppliers' }),
  }),
  line('note', 'Allowed automatically: Read package.json', d0 + 27 * MIN),
  line('user', 'Plan for the week?', d1),
  line('agent', NESTED, d1 + MIN),
  line('agent', NO_SPACES, d1 + 3 * MIN),
  line('user', 'What are customers saying? 🙏 العملاء 顧客', d1 + 30 * MIN),
  line('agent', SCRIPTS, d1 + 31 * MIN),
  line('agent', IMAGES, d1 + 32 * MIN),
  line('approval', '', d1 + 33 * MIN, {
    approval: {
      requestId: 'sec-torture',
      title: 'Secure input · shop_admin_token',
      detail: SECRET.purpose,
      status: 'pending',
      secret: SECRET,
    },
  }),
  line('agent', 'Pulling this week’s returns into one place.', d1 + 34 * MIN),
  line('agent', RESULT_V1.summary, d1 + 60 * MIN, { id: 'res-v1', result: RESULT_V1 }),
  line('user', 'Group them by courier.', d1 + 70 * MIN, {
    revises: { id: 'res-returns', version: 1, title: 'Returns this week' },
  }),
  line('agent', RESULT_V2.summary, d1 + 80 * MIN, { id: 'res-v2', result: RESULT_V2 }),
  line('error', 'The engine stopped: the connection to the model was reset.', d1 + 90 * MIN, {
    failure: { kind: 'other' },
  }),
  line(
    'agent',
    'I was halfway through drafting the depot complaint when you stopped me: “Dear Northline Depot, five of our',
    d1 + 95 * MIN,
    { stopped: true }
  ),
  line('note', 'Started fresh. Memory kept.', d2 - 30 * MIN, { fresh: true }),
  line('user', 'x', d2 - 20 * MIN),
  line('user', 'y', d2 - 20 * MIN + 1000),
  line('user', 'and one more thing, quickly', d2 - 20 * MIN + 2000),
  line('agent', 'Got all three.', d2 - 19 * MIN),
  line('approval', '', d2 - 5 * MIN, {
    approval: {
      requestId: 'settings-torture',
      title: 'Change Returns’ settings?',
      detail: SETTINGS_SUMMARY,
      summary: SETTINGS_SUMMARY,
      status: 'pending',
      settings: {
        targets: [{ kind: 'agent', agentId: 'returns' }],
        change: { addRules: ['Refunds over €200 need your OK'] },
        version: 2,
        groups: [
          {
            who: 'Returns',
            agentIds: ['returns'],
            changes: [
              'Can now read the shop admin',
              'New rule: “Refunds over €200 need your OK” (an instruction, not enforced)',
            ],
          },
        ],
        why: 'You asked Returns to handle refunds',
        hasRules: false,
      },
    },
  }),
  line('approval', '', d2, { approval: approval('pending') }),
];

// ── The 5,000-line chat ─────────────────────────────────────────────────────

const BIG_N = 5000;
let big: Record<string, unknown>[] | null = null;
const bigLog = () =>
  (big ??= Array.from({ length: BIG_N }, (_, i) => {
    const ts = now - (BIG_N - i) * 7 * MIN;
    const base = { id: `b${i}`, agentId: 'chief', ts };
    if (i % 2 === 0)
      return { ...base, kind: 'user', text: `Question ${i}: what about order LP-${i}?` };
    if (i % 25 === 1)
      return {
        ...base,
        kind: 'approval',
        text: '',
        approval: approval(i % 50 === 1 ? 'denied' : 'allowed'),
      };
    if (i % 11 === 3) return { ...base, kind: 'agent', text: WIDE_TABLE };
    return {
      ...base,
      kind: 'agent',
      text: `Answer ${i}. ${'Checked the order and the stock. '.repeat(1 + (i % 6))}`,
    };
  }));

const page = (log: Record<string, unknown>[], args: Record<string, unknown>) => {
  const {
    limit = 150,
    before,
    through,
  } = args as {
    limit?: number;
    before?: string;
    through?: string;
  };
  const end = before ? log.findIndex((m) => m.id === before) : log.length;
  let start = Math.max(0, end - limit);
  const at = through ? log.findIndex((m) => m.id === through) : -1;
  if (at >= 0 && at < start) start = at;
  return log.slice(start, end);
};

// ── The driver ──────────────────────────────────────────────────────────────

const SCENARIO_IDS = ['agents-torture', 'agents-torture-empty', 'agents-torture-5000'];
const here =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('scenario')
    : null;

/** The log the open scenario serves; events append to it so a reload agrees. */
const logOf = (agentId: string): Record<string, unknown>[] | null => {
  if (here === 'agents-torture' && agentId === 'chief') return TORTURE;
  if (here === 'agents-torture-5000' && agentId === 'chief') return bigLog();
  if (here === 'agents-torture-empty' && agentId === 'quiet') return QUIET;
  return null;
};
const QUIET: Record<string, unknown>[] = [];

declare global {
  interface Window {
    __torture?: {
      stream: (o?: { words?: number; every?: number; agentId?: string }) => Promise<string>;
      duplicate: () => void;
      outOfOrder: () => void;
      burst: (n?: number) => void;
      answer: () => void;
      replace: () => void;
      lateDraft: () => void;
      card: () => void;
    };
  }
}

const chiefLog = () => logOf('chief') ?? [];
const say = (m: Record<string, unknown>, keep = true) => {
  if (keep) {
    const log = logOf(String(m.agentId)) ?? chiefLog();
    const at = log.findIndex((x) => x.id === m.id);
    if (at === -1) log.push(m);
    else log[at] = m;
  }
  void emit('agents://message', m);
};
let live = 0;

if (here && SCENARIO_IDS.includes(here)) {
  window.__torture = {
    stream: ({ words = 300, every = 30, agentId = 'chief' } = {}) =>
      new Promise((resolve) => {
        const parts = Array.from({ length: words }, (_, i) =>
          i % 60 === 59 ? '\n\n```ts\nconst x = 1;\n```\n\n' : i % 20 === 19 ? 'word.\n\n' : 'word '
        );
        const id = `live-${++live}`;
        let i = 0;
        const t = window.setInterval(() => {
          i += 4;
          void emit('agents://draft', { agentId, id, text: parts.slice(0, i).join('') });
          if (i >= parts.length) {
            clearInterval(t);
            say({ id, agentId, ts: Date.now(), kind: 'agent', text: parts.join('') });
            resolve(id);
          }
        }, every);
      }),
    duplicate: () => {
      const last = chiefLog()[chiefLog().length - 1];
      if (!last) return;
      say({ ...last }, false);
      say({ ...last }, false);
    },
    outOfOrder: () => {
      const t = Date.now();
      const first = {
        id: `ooo-${++live}`,
        agentId: 'chief',
        ts: t - 500,
        kind: 'agent',
        text: 'Written first (arrives second).',
      };
      const second = {
        id: `ooo-${++live}`,
        agentId: 'chief',
        ts: t,
        kind: 'agent',
        text: 'Written second (arrives first).',
      };
      say(second);
      say(first);
      // The served log is in written order, as the backend's file is.
      chiefLog().sort((a, b) => Number(a.ts) - Number(b.ts));
    },
    burst: (n = 20) => {
      const t = Date.now();
      for (let i = 0; i < n; i++)
        say({
          id: `burst-${++live}`,
          agentId: 'chief',
          ts: t + i,
          kind: i % 2 ? 'agent' : 'user',
          text: `Burst line ${i + 1} of ${n}`,
        });
    },
    answer: () => {
      const card = [...chiefLog()]
        .reverse()
        .find((m) => (m.approval as { status?: string } | undefined)?.status === 'pending');
      if (!card) return;
      say({ ...card, approval: { ...(card.approval as object), status: 'allowed' } });
    },
    replace: () => {
      const last = [...chiefLog()].reverse().find((m) => m.kind === 'agent');
      if (!last) return;
      say({ ...last, text: `${String(last.text)}\n\n*(edited: one line added)*` });
    },
    // A reply, then the card its next step waits on, a moment apart, as a
    // turn posts them: the chat must end on the card's answers.
    card: () => {
      const t = Date.now();
      const status = (state: string, activity: string | null) =>
        void emit('agents://status', {
          agentId: 'chief',
          status: { state, activity, since: Date.now() },
        });
      status('working', 'Running npm test');
      say({
        id: `card-reply-${++live}`,
        agentId: 'chief',
        ts: t,
        kind: 'agent',
        text: 'Tests pass. Pushing the branch next, which needs your OK.',
      });
      window.setTimeout(() => {
        say({
          id: `card-${++live}`,
          agentId: 'chief',
          ts: t + 300,
          kind: 'approval',
          text: '',
          approval: {
            requestId: `card-req-${live}`,
            title: 'Run a command',
            detail: 'git push origin returns-by-courier',
            status: 'pending',
            tool: 'Bash',
            input: { command: 'git push origin returns-by-courier' },
          },
        });
        status('waiting', null);
      }, 300);
    },
    lateDraft: () => {
      const last = [...chiefLog()].reverse().find((m) => m.kind === 'agent');
      if (!last) return;
      void emit('agents://draft', { agentId: 'chief', id: last.id, text: 'Half of it' });
    },
  };
}

const team = TEAM.map((a) => ({ ...a }));
const withQuiet = [
  ...team,
  agent('quiet', 'Packaging', { color: 'teal', role: 'Boxes and labels', minutesAgo: 5 }),
];

const serve = (args: Record<string, unknown>) => {
  const log = logOf(String(args.agentId));
  return log ? page(log, args) : messagesFor(args);
};

export const agentsTortureScenarios: Scenario[] = [
  {
    id: 'agents-torture',
    title: 'Agents — chat torture: every kind of line and card over three days',
    looksRightWhen:
      'The Chief chat ends on a pending Allow / Deny card with a settings-change card above it. Scrolling up: day dividers between the three days; the huge code block scrolls sideways inside its panel; the wide table scrolls sideways inside its own frame and never widens the chat; the long URL, path, token and German word wrap inside the measure; emoji, Japanese, Chinese, Hebrew and Arabic lines render and RTL lines read right to left; images are “Image from cdn.example.com” chips, never loaded; expired cards are one-line receipts; result v2 says what changed. Nothing touches the chat’s edges, no horizontal scrollbar on the chat.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat .agent-approval',
    mockEvents: true,
    commands: {
      agents_overview: () => overview(team.map((a) => ({ ...a }))),
      agents_messages: serve,
      agents_send: (args: Record<string, unknown>) => {
        const m = {
          id: `sent-${++live}`,
          agentId: String(args.agentId),
          ts: Date.now(),
          kind: 'user',
          text: String(args.text),
        };
        chiefLog().push(m);
        return m;
      },
    },
  },
  {
    id: 'agents-torture-empty',
    title: 'Agents — chat torture: an agent with no lines yet',
    looksRightWhen:
      'Packaging’s chat is empty: its empty state centred, the composer focused and usable, no stray divider, timestamp or loading row.',
    openSelector: AGENTS_TAB,
    steps: [{ click: '[data-agent-id="quiet"]' }],
    requires: '.agent-chat',
    mockEvents: true,
    commands: {
      agents_overview: () => overview(withQuiet.map((a) => ({ ...a }))),
      agents_messages: serve,
    },
  },
  {
    id: 'agents-torture-5000',
    title: 'Agents — chat torture: a 5,000-line chat',
    looksRightWhen:
      'Opens on the newest page, pinned to the bottom; scrolling up loads older pages without the view jumping; nothing is doubled at a page seam.',
    openSelector: AGENTS_TAB,
    requires: '.agent-chat .agent-bubble--agent',
    mockEvents: true,
    commands: {
      agents_overview: () => overview(team.map((a) => ({ ...a }))),
      agents_messages: serve,
    },
  },
];
