/**
 * `--torture`: the chat torture set, the phone's copy of the desk harness's
 * `agents-torture` scenarios (src/harness/scenarios/agentsTorture.ts).
 *
 * - "Torture": three days of every kind of line and card at once: very long
 *   prose, a huge code block, a wide table, nested lists, URLs and tokens
 *   with no spaces, emoji / RTL / CJK, images as chips, approvals pending /
 *   allowed / expired, a secure-input card, a settings change, a result v1
 *   then v2, an error, a stopped reply, a fresh-start divider.
 * - "Long Chat": 5,000 lines, paged as the Mac pages them.
 * - "Long Rich": 5,000 lines of every kind (markdown and code, timelines,
 *   result and approval cards, pictures): the desk's `agents-stress` chat at
 *   `--lines 5000`, for `qa:web --phases perf`.
 * - "Quiet": no lines at all.
 *
 * `GET /dev/torture?do=<action>` (this mode only) drives the event orders a
 * live link produces: duplicate, outOfOrder, burst, stream, lateDraft,
 * answer, replace. Every name, address and number is made up.
 */

import type { Agent, AgentMessage, CompanionEvent } from '@shipstudio/companion-protocol';

type Base = (id: string, name: string, role: string, color: string, extra: Partial<Agent>) => Agent;

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;

const LONG = Array.from(
  { length: 10 },
  (_, i) =>
    `Paragraph ${i + 1}. The supplier confirmed the revised delivery window for the spring range, but the freight quote still assumes the old pallet count, so the landed cost per unit is overstated by about four percent until they resend it.`
).join('\n\n');

const HUGE_CODE = [
  'The whole migration, before it runs:',
  '',
  '```ts',
  ...Array.from(
    { length: 80 },
    (_, i) =>
      `export const step${String(i).padStart(3, '0')} = (db: Db) => db.exec("UPDATE inventory SET reorder_point = reorder_point + ${i} WHERE sku LIKE 'LP-${i}-%'");`
  ),
  '```',
].join('\n');

const WIDE_TABLE = [
  'The comparison:',
  '',
  '| Supplier | Region | Lead time | MOQ | Unit | Freight | Landed | Terms | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| Northwind Textiles Cooperative | Porto, PT | 21 days | 400 | €3.10 | €0.42 | €3.52 | 30 days net | Organic cotton only |',
  '| 山田陶器 (Yamada Pottery) | 瀬戸市, JP | 48 days | 60 | ¥1,240 | ¥310 | ¥1,600 | 60 days | Hand-thrown |',
  '| شركة النخيل للتجارة | دبي | 18 days | 1,000 | $1.95 | $0.38 | $2.45 | LC at sight | Fastest |',
].join('\n');

const NESTED = [
  'The plan:',
  '',
  '1. Inventory',
  '   - Count the north warehouse',
  '     - Aisles 1–12 on Monday',
  '       - Flag anything under its reorder point',
  '   - Reconcile against the shop export',
  '2. Pricing',
  '   1. Pull the landed costs',
  '   2. Re-price anything under 45% margin',
].join('\n');

const NO_SPACES = [
  'https://shop.larchandpine.example/collections/spring-range-2027/products/hand-thrown-stoneware-serving-bowl-large-speckled-oat?variant=4419027733&utm_campaign=spring_launch_early_access_vip_segment_b',
  '',
  '~/ShipStudio/larch-and-pine-storefront/src/components/product-detail/variant-picker/VariantPickerWithInventoryAwareSwatches.tsx',
  '',
  `Token: ${'a1b2c3d4e5f6'.repeat(12)}`,
].join('\n');

const SCRIPTS = [
  'Customer replies this week:',
  '',
  '- 🎉🎉🎉 Love the new bowls!!! 🥣✨ 👩🏽‍🍳👨‍👩‍👧‍👦🏳️‍🌈 Ordering three more 💯',
  '- 商品はとても美しいですが、配送に二週間かかりました。',
  '- 这个碗的颜色和网站上的照片不太一样，可以换货吗？',
  '- המשלוח הגיע שבור. אפשר לקבל החזר כספי? (order #LP-20931)',
  '- الطلب وصل ناقصاً قطعة واحدة، أرجو المساعدة. رقم الطلب LP-20944',
].join('\n');

const IMAGES =
  'The photos they sent: <img src="https://cdn.example.com/returns/IMG_4412.jpg"> and ![broken bowl](https://cdn.example.com/returns/IMG_4413.jpg). I haven’t opened either.';

const EMAIL =
  'To: orders@northwind-textiles.example\nSubject: Revised pallet count for PO-7781\n\nHi Ana, could you resend the freight quote for 14 pallets rather than 18? Thanks, Sam';

const RESULT_V1 = {
  id: 'res-returns',
  version: 1,
  title: 'Returns this week',
  summary:
    'Nine returns this week: six breakages in transit, two wrong colours, one change of mind.',
  items: [
    {
      kind: 'link' as const,
      url: 'https://sheets.example.com/d/returns-w44',
      label: 'Returns sheet',
    },
  ],
  checked: ['Every return matches an order in the export'],
  notVerified: ['Two photos weren’t opened, so the breakage is the customer’s word'],
};
const RESULT_V2 = {
  ...RESULT_V1,
  version: 2,
  summary: 'Nine returns, grouped by courier: five of the six breakages came through one depot.',
  changes: 'Grouped by courier; the depot pattern is new',
};

export function addTortureAccount(
  agents: Agent[],
  messages: Map<string, AgentMessage[]>,
  base: Base,
  now: number
) {
  agents.push(
    base('torture', 'Torture', 'Every kind of line at once', 'red', {
      lastActivityAt: now - 2 * MIN,
      pendingApprovals: 2,
      preview: 'Needs your OK',
    }),
    base('longchat', 'Long Chat', 'Five thousand lines', 'blue', {
      lastActivityAt: now - 5 * MIN,
      preview: `Answer ${4999}`,
    }),
    base('quiet', 'Quiet', 'Nothing said yet', 'teal', { lastActivityAt: now - 9 * MIN }),
    base('longrich', 'Long Rich', 'Five thousand lines of everything', 'purple', {
      lastActivityAt: now - 6 * MIN,
      preview: 'Plain reply 4999',
    })
  );

  const t: AgentMessage[] = [];
  const add = (
    kind: AgentMessage['kind'],
    text: string,
    ts: number,
    extra: Partial<AgentMessage> = {}
  ) =>
    t.push({
      id: `tt_${String(t.length).padStart(3, '0')}`,
      agentId: 'torture',
      ts,
      kind,
      text,
      ...extra,
    });
  const d0 = now - 2 * DAY - 3 * H;
  const d1 = now - DAY - 2 * H;
  const d2 = now - 50 * MIN;
  add('user', 'Morning! Can you go through the supplier mess from last week?', d0);
  add('agent', LONG, d0 + 2 * MIN);
  add('agent', HUGE_CODE, d0 + 12 * MIN);
  add('approval', '', d0 + 13 * MIN, {
    approval: {
      requestId: 'tq1',
      title: 'Run a command',
      detail: 'pnpm db:migrate',
      status: 'allowed',
      tool: 'Bash',
    },
  });
  add('agent', WIDE_TABLE, d0 + 20 * MIN);
  add('approval', '', d0 + 25 * MIN, {
    approval: {
      requestId: 'tq2',
      title: 'Email Fjordline',
      detail: EMAIL,
      status: 'expired',
      expiry: 'moved_on',
    },
  });
  add('user', 'Plan for the week?', d1);
  add('agent', NESTED, d1 + MIN);
  add('agent', NO_SPACES, d1 + 3 * MIN);
  add('user', 'What are customers saying? 🙏 العملاء 顧客', d1 + 30 * MIN);
  add('agent', SCRIPTS, d1 + 31 * MIN);
  add('agent', IMAGES, d1 + 32 * MIN);
  add('agent', RESULT_V1.summary, d1 + 60 * MIN, { result: RESULT_V1 });
  add('user', 'Group them by courier.', d1 + 70 * MIN, {
    revises: { id: 'res-returns', version: 1, title: 'Returns this week' },
  });
  add('agent', RESULT_V2.summary, d1 + 80 * MIN, { result: RESULT_V2 });
  add('error', 'The engine stopped: the connection to the model was reset.', d1 + 90 * MIN);
  add(
    'agent',
    'I was halfway through the depot complaint when you stopped me: “Dear Northline Depot, five of our',
    d1 + 95 * MIN,
    {
      stopped: true,
    }
  );
  add('note', 'Started fresh. Memory kept.', d2 - 30 * MIN, { fresh: true });
  add('user', 'x', d2 - 20 * MIN);
  add('user', 'y', d2 - 20 * MIN + 1000);
  add('agent', 'Got both.', d2 - 19 * MIN);
  add('approval', '', d2 - 5 * MIN, {
    approval: {
      requestId: 'tq3',
      title: 'Secure input · shop_admin_token',
      detail: 'Read last week’s orders from the shop admin to match the returns.',
      status: 'pending',
      secret: {
        name: 'shop_admin_token',
        purpose: 'Read last week’s orders from the shop admin to match the returns.',
        kind: 'api_key',
        fields: [{ label: 'Admin API token', env: 'SHOP_ADMIN_TOKEN' }],
        reference: 'secret:torture/shop_admin_token',
      },
    } as AgentMessage['approval'],
  });
  add('approval', '', d2, {
    approval: {
      requestId: 'tq4',
      title: 'Send an email',
      detail: EMAIL,
      status: 'pending',
      tool: 'mcp__gmail__send',
    },
  });
  messages.set('torture', t);

  messages.set(
    'longchat',
    Array.from({ length: 5000 }, (_, i): AgentMessage => {
      const ts = now - (5000 - i) * 7 * MIN;
      const base = { id: `lc_${String(i).padStart(4, '0')}`, agentId: 'longchat', ts };
      if (i % 2 === 0)
        return { ...base, kind: 'user', text: `Question ${i}: what about order LP-${i}?` };
      if (i % 11 === 3) return { ...base, kind: 'agent', text: WIDE_TABLE };
      return {
        ...base,
        kind: 'agent',
        text: `Answer ${i}. ${'Checked the order and the stock. '.repeat(1 + (i % 5))}`,
      };
    })
  );
  messages.set('quiet', []);
  messages.set('longrich', longRich(now));
}

const richWork = (t0: number) =>
  ({
    startedAt: t0,
    endedAt: t0 + 240_000,
    stepCount: 60,
    fileCount: 3,
    files: ['src/a.tsx', 'src/b.css', 'src/c.ts'],
    steps: Array.from({ length: 60 }, (_, s) => ({
      at: t0 + s * 4000,
      kind: (['read', 'edit', 'search', 'web', 'command'] as const)[s % 5],
      label: `Step ${s + 1}: read thing-${s}.tsx`,
    })),
  }) as AgentMessage['work'];
const richMarkdown = (i: number) =>
  [
    `### Update ${i}`,
    `Here is what I found about **item ${i}**, with \`inline code\` and a [link](https://example.com/${i}).`,
    '',
    '- first point',
    '- second point',
    '',
    '| Client | Due |',
    '| --- | --- |',
    `| Acme | $${i * 10} |`,
  ].join('\n');
const FENCE = '```';
const richCode = (i: number) =>
  `Here is the fix:\n\n${FENCE}ts\nexport function price${i}(n: number) {\n  return n * ${i};\n}\n${FENCE}`;

/** Every ten lines: questions, markdown with a timeline, code, a result, a card, a picture, a note. */
function longRich(now: number): AgentMessage[] {
  return Array.from({ length: 5000 }, (_, i): AgentMessage => {
    const ts = now - (5000 - i) * 3 * MIN;
    const base = { id: `lr_${String(i).padStart(4, '0')}`, agentId: 'longrich', ts };
    switch (i % 10) {
      case 0:
      case 5:
        return { ...base, kind: 'user', text: `Question ${i}: can you check item ${i}?` };
      case 1:
        return { ...base, kind: 'agent', text: richMarkdown(i), work: richWork(ts - 240_000) };
      case 2:
        return { ...base, kind: 'agent', text: richCode(i) };
      case 3:
        return {
          ...base,
          kind: 'agent',
          text: `Report ${i}, grouped by client.`,
          result: { ...RESULT_V1, id: `lr-res-${i}`, title: `Report ${i}` },
          work: richWork(ts - 240_000),
        };
      case 4:
        return {
          ...base,
          kind: 'approval',
          text: '',
          approval: {
            requestId: `lr-req-${i}`,
            title: 'Run a command',
            detail: `npm run build -- --item ${i}`,
            status: 'allowed',
            tool: 'Bash',
          } as AgentMessage['approval'],
        };
      case 6:
        return {
          ...base,
          kind: 'user',
          text: 'Screenshots attached',
          attachments: [
            {
              name: 'a.jpg',
              path: `attachments/${base.id}/a.jpg`,
              mime: 'image/jpeg',
              size: 27_238,
            },
          ],
        } as AgentMessage;
      case 8:
        return { ...base, kind: 'note', text: 'Allowed automatically: Read package.json' };
      default:
        return {
          ...base,
          kind: 'agent',
          text: `Plain reply ${i}. Done, the cards stack below 640px.`,
        };
    }
  });
}

export interface TortureWorld {
  messages: Map<string, AgentMessage[]>;
  putMessage: (m: AgentMessage) => void;
  /** Journal an event as-is (a duplicate, or one out of order). */
  emit: (event: CompanionEvent & { type: 'agents.message' }) => void;
  draft: (event: Extract<CompanionEvent, { type: 'agents.draft' }>) => void;
}

let live = 0;

/** One driver action; resolves once its events are out. */
export async function tortureAction(w: TortureWorld, action: string, n = 20): Promise<string> {
  const list = () => w.messages.get('torture') ?? [];
  const lastAgent = () => [...list()].reverse().find((m) => m.kind === 'agent');
  switch (action) {
    case 'duplicate': {
      const last = list()[list().length - 1];
      if (last) {
        w.emit({ type: 'agents.message', message: { ...last } });
        w.emit({ type: 'agents.message', message: { ...last } });
      }
      return 'ok';
    }
    case 'outOfOrder': {
      const t = Date.now();
      const first: AgentMessage = {
        id: `ooo_${++live}`,
        agentId: 'torture',
        ts: t - 500,
        kind: 'agent',
        text: 'Written first (arrives second).',
      };
      const second: AgentMessage = {
        id: `ooo_${++live}`,
        agentId: 'torture',
        ts: t,
        kind: 'agent',
        text: 'Written second (arrives first).',
      };
      w.putMessage(second);
      w.putMessage(first);
      list().sort((a, b) => a.ts - b.ts);
      return 'ok';
    }
    case 'burst': {
      const t = Date.now();
      for (let i = 0; i < n; i++)
        w.putMessage({
          id: `burst_${++live}`,
          agentId: 'torture',
          ts: t + i,
          kind: i % 2 ? 'agent' : 'user',
          text: `Burst line ${i + 1} of ${n}`,
        });
      return 'ok';
    }
    case 'stream': {
      const id = `live_${++live}`;
      const words = Array.from({ length: n * 10 }, (_, i) =>
        i % 20 === 19 ? 'word.\n\n' : 'word '
      );
      let sent = 0;
      for (let i = 4; i <= words.length; i += 4) {
        const text = words.slice(0, i).join('');
        w.draft({
          type: 'agents.draft',
          agentId: 'torture',
          id,
          from: sent,
          text: text.slice(sent),
        });
        sent = text.length;
        await new Promise((r) => setTimeout(r, 30));
      }
      w.putMessage({ id, agentId: 'torture', ts: Date.now(), kind: 'agent', text: words.join('') });
      return id;
    }
    case 'lateDraft': {
      const last = lastAgent();
      if (last)
        w.draft({
          type: 'agents.draft',
          agentId: 'torture',
          id: last.id,
          from: 0,
          text: 'Half of it',
        });
      return 'ok';
    }
    case 'answer': {
      const card = [...list()].reverse().find((m) => m.approval?.status === 'pending');
      if (card?.approval)
        w.putMessage({ ...card, approval: { ...card.approval, status: 'allowed' } });
      return 'ok';
    }
    case 'replace': {
      const last = lastAgent();
      if (last) w.putMessage({ ...last, text: `${last.text}\n\n*(edited: one line added)*` });
      return 'ok';
    }
    default:
      return 'unknown';
  }
}
