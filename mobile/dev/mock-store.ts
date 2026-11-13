/**
 * `--store=pending|allowed|published`: the App Store screenshots' cast, the
 * same as the site's hero. Chief of Staff, Ostler site (the ostler-type
 * project behind ostlertype.com), Research, Inbox and Finance. Ostler site is
 * midway through publishing the Studio licence page:
 *
 * - `pending`: its card "Publish the Studio licence page?" waits for you
 * - `allowed`: the card just allowed, the agent publishing
 * - `published`: done, ending on its result card with the live page's picture
 *
 * Everything here is fictional. Taken by docs/app-store.md, "Screenshots".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Agent, AgentMessage, Attachment } from '@shipstudio/companion-protocol';

export type StoreStage = 'pending' | 'allowed' | 'published';

export const STORE_PROJECT = '/Users/you/ShipStudio/ostler-type';
export const STORE_CHANGES_ID = 'ostler_changes';

const MIN = 60_000;
const HOUR = 60 * MIN;

type Base = (id: string, name: string, role: string, color: string, extra: Partial<Agent>) => Agent;
type Attach = (
  agentId: string,
  messageId: string,
  name: string,
  mime: string,
  bytes: Buffer
) => Attachment;

const picture = () => readFileSync(path.join(__dirname, 'store', 'ostler-licence.png'));

const working = (now: number, activity: string, steps: [string, string][]): Agent['status'] => ({
  state: 'working',
  activity,
  since: now - 4 * MIN,
  work: {
    startedAt: now - 4 * MIN,
    stepCount: steps.length,
    fileCount: 0,
    steps: steps.map(([kind, label], i) => ({
      at: now - (4 - i) * MIN,
      kind: kind as 'read',
      label,
      ...(i < steps.length - 1 ? { endedAt: now - (3 - i) * MIN } : {}),
    })),
    doing: activity,
  },
});

export function storeAgents(base: Base, now: number, stage: StoreStage): Agent[] {
  const waiting = stage === 'pending';
  return [
    base('chief', 'Chief of Staff', 'Runs the team', 'white', {
      isMain: true,
      pinned: true,
      lastActivityAt: now - 12 * MIN,
      preview: 'Ostler site needs your OK to publish. The rest is moving.',
    }),
    base('ostler', 'Ostler site', 'ostlertype.com', 'blue', {
      project: STORE_PROJECT,
      lastActivityAt: now - MIN,
      pendingApprovals: waiting ? 1 : 0,
      unread: waiting ? 1 : 0,
      preview: waiting
        ? 'Needs your OK'
        : stage === 'allowed'
          ? 'Publishing the Studio licence page'
          : 'The Studio licence page is live.',
      status:
        stage === 'allowed'
          ? working(now, 'Publishing to ostlertype.com', [
              ['command', 'Pushed studio-licence to main'],
              ['web', 'Waiting for the deploy'],
            ])
          : { state: 'idle', activity: null, since: null },
    }),
    base('research', 'Research', 'Type market and competitors', 'amber', {
      lastActivityAt: now - 2 * MIN,
      preview: 'Comparing studio licence prices at six foundries.',
      status: working(now, 'Comparing studio licence prices', [
        ['web', 'Read Klim’s licensing page'],
        ['web', 'Read Commercial Type’s price list'],
        ['edit', 'Updating foundry-prices.md'],
      ]),
    }),
    base('inbox', 'Inbox', 'Email and replies', 'purple', {
      lastActivityAt: now - 3 * MIN,
      preview: 'Drafting replies to three licence questions.',
      status: working(now, 'Drafting replies to licence questions', [
        ['read', 'Read 14 new emails'],
        ['edit', 'Drafting a reply to Mara at Northfold'],
      ]),
    }),
    base('finance', 'Finance', 'Invoices and payouts', 'green', {
      lastActivityAt: now - 5 * MIN,
      preview: 'Matching October’s Stripe payouts to invoices.',
      status: working(now, 'Matching Stripe payouts to invoices', [
        ['read', 'Read the October payouts'],
        ['edit', 'Updating invoices-2026.xlsx'],
      ]),
    }),
  ];
}

export function storeMessages(
  now: number,
  stage: StoreStage,
  attach: Attach
): Map<string, AgentMessage[]> {
  const out = new Map<string, AgentMessage[]>();
  const add = (agentId: string, m: Omit<AgentMessage, 'agentId'>) => {
    const list = out.get(agentId) ?? [];
    list.push({ agentId, ...m } as AgentMessage);
    out.set(agentId, list);
  };

  // ---- Chief of Staff: the morning brief ------------------------------------
  add('chief', {
    id: 'chief_1',
    ts: now - 40 * MIN,
    kind: 'user',
    text: 'What needs me today?',
  });
  add('chief', {
    id: 'chief_2',
    ts: now - 39 * MIN,
    kind: 'agent',
    text: 'Three things:\n\n1. **Ostler site** has the Studio licence page ready. It waits for your OK before it goes live.\n2. **Inbox** is drafting replies to three licence questions. Nothing sends without you.\n3. **Finance** is matching October’s payouts and should be done before lunch.\n\n**Research** is pricing studio licences at six other foundries.',
  });

  // ---- Ostler site: the Studio licence page --------------------------------
  const shot = attach('ostler', 'ostler_4', 'Studio licence.png', 'image/png', picture());
  add('ostler', {
    id: 'ostler_1',
    ts: now - 45 * MIN,
    kind: 'user',
    text: 'Add a Studio licence page: one licence for up to 25 people, every family, £960. Same look as the Typefaces page.',
  });
  add('ostler', {
    id: 'ostler_2',
    ts: now - 30 * MIN,
    kind: 'agent',
    text: 'Done in my own copy of ostler-type. The page has the three tiers, Studio in the middle, with prices from your pricing sheet.',
  });
  add('ostler', {
    id: STORE_CHANGES_ID,
    ts: now - 29 * MIN,
    kind: 'changes',
    text: '',
    changes: {
      project: STORE_PROJECT,
      branch: 'ostler-type/studio-licence',
      from: '4c1e9a2',
      to: '8b37d05',
      files: [
        { path: 'src/pages/studio-licence.astro', status: 'added', added: 64, removed: 0 },
        { path: 'src/components/Tiers.astro', status: 'added', added: 38, removed: 0 },
        { path: 'src/components/Nav.astro', status: 'modified', added: 2, removed: 1 },
        { path: 'src/styles/tiers.css', status: 'added', added: 27, removed: 0 },
      ],
      fileCount: 4,
      added: 131,
      removed: 1,
      copy: {
        id: 'copy_licence',
        path: '/Users/you/ShipStudio/.worktrees/ostler-type/studio-licence-3e1a',
        branch: 'ostler-type/studio-licence',
      },
    },
  });
  add('ostler', {
    id: 'ostler_4',
    ts: now - 28 * MIN,
    kind: 'agent',
    text: 'Here it is in the preview.',
    result: {
      items: [{ kind: 'file', file: shot, label: 'Studio licence, in the preview' }],
      id: 'res_licence',
      version: 1,
      title: 'Studio licence page',
      summary:
        'A new /studio-licence page: Solo £180, Studio £960 and Agency £2,400, in the Typefaces page’s type and colours, linked from the top menu.',
      project: STORE_PROJECT,
      checked: [
        'The site builds with no errors',
        'Reads well on a phone, a tablet and a laptop',
        'Prices match the pricing sheet',
      ],
      notVerified: ['The Buy buttons: they go to checkout links you haven’t made yet'],
    },
  });
  add('ostler', {
    id: 'ostler_5',
    ts: now - 2 * MIN,
    kind: 'user',
    text: 'Looks great. Put it live.',
  });
  add('ostler', {
    id: 'ostler_6',
    ts: now - MIN,
    kind: 'approval',
    text: '',
    approval: {
      requestId: 'req_publish_licence',
      title: 'Publish the Studio licence page?',
      summary: 'Push studio-licence to main. Vercel then puts it live on ostlertype.com.',
      detail: 'git push origin studio-licence:main\n\n4 files · +131 −1',
      status: stage === 'pending' ? 'pending' : 'allowed',
    },
  });
  if (stage !== 'pending') {
    add('ostler', {
      id: 'ostler_7',
      ts: now - 40_000,
      kind: 'agent',
      text: 'Pushed. Vercel is building it now; I’ll check the live page when it’s up.',
    });
  }
  if (stage === 'published') {
    const live = attach('ostler', 'ostler_8', 'ostlertype.com.png', 'image/png', picture());
    add('ostler', {
      id: 'ostler_8',
      ts: now - 10_000,
      kind: 'agent',
      text: 'It’s live.',
      result: {
        items: [
          { kind: 'file', file: live, label: 'ostlertype.com/studio-licence' },
          {
            kind: 'link',
            url: 'https://ostlertype.com/studio-licence',
            label: 'ostlertype.com/studio-licence',
          },
        ],
        id: 'res_licence_live',
        version: 1,
        title: 'Studio licence page is live',
        summary: 'ostlertype.com/studio-licence is up, and the top menu links to it.',
        project: STORE_PROJECT,
        checked: [
          'Vercel says the deploy is Ready',
          'The live page matches the preview',
          'The menu link opens it on a phone',
        ],
        notVerified: ['A real purchase: the checkout links aren’t made yet'],
      },
    });
  }

  // ---- The others, each midway ---------------------------------------------
  add('research', {
    id: 'research_1',
    ts: now - 20 * MIN,
    kind: 'user',
    text: 'What do other foundries charge for a studio licence?',
  });
  add('inbox', {
    id: 'inbox_1',
    ts: now - 15 * MIN,
    kind: 'user',
    text: 'Answer the licence questions from this week. Show me before anything goes.',
  });
  add('finance', {
    id: 'finance_1',
    ts: now - 25 * MIN,
    kind: 'user',
    text: 'Match October’s Stripe payouts to the invoices and tell me what’s missing.',
  });
  return out;
}

/** What `agents.changeDiff` answers for the licence page's files. */
export const STORE_DIFF: Record<string, string> = {
  'src/pages/studio-licence.astro': `@@ -0,0 +1,18 @@\n+---\n+import Layout from '../layouts/Layout.astro';\n+import Tiers from '../components/Tiers.astro';\n+---\n+<Layout title="Studio licence · Ostler Type">\n+  <h1>Studio licence</h1>\n+  <p class="lead">\n+    One licence for the whole studio: every Ostler family, desktop,\n+    web and app use, for up to 25 people.\n+  </p>\n+  <Tiers tiers={[\n+    { name: 'Solo', price: '£180', note: '1 person · desktop and web' },\n+    { name: 'Studio', price: '£960', note: 'Up to 25 people · every family', featured: true },\n+    { name: 'Agency', price: '£2,400', note: 'Unlimited people · client projects' },\n+  ]} />\n+</Layout>\n`,
  'src/components/Tiers.astro': `@@ -0,0 +1,12 @@\n+---\n+const { tiers } = Astro.props;\n+---\n+<div class="tiers">\n+  {tiers.map((t) => (\n+    <div class:list={['tier', { on: t.featured }]}>\n+      <h3>{t.name}</h3>\n+      <p class="price">{t.price}</p>\n+      <small>{t.note}</small>\n+    </div>\n+  ))}\n+</div>\n`,
  'src/components/Nav.astro': `@@ -6,5 +6,6 @@\n   <nav>\n     <a href="/">Ostler Type</a>\n     <a href="/typefaces">Typefaces</a>\n-    <a href="/journal">Journal</a>\n+    <a href="/studio-licence">Studio licence</a>\n+    <a href="/journal">Journal</a>\n   </nav>\n`,
  'src/styles/tiers.css': `@@ -0,0 +1,9 @@\n+.tiers { display: grid; gap: 1.25rem; grid-template-columns: repeat(3, 1fr); }\n+.tier { border: 1px solid var(--ink); border-radius: 4px; padding: 1.5rem; }\n+.tier.on { background: var(--ink); color: var(--paper); }\n+.price { font-size: 2.75rem; margin: 1rem 0 .5rem; }\n+@media (max-width: 720px) {\n+  .tiers { grid-template-columns: 1fr; }\n+}\n`,
};

/** Several Claude and ChatGPT (Codex) accounts, with this week's use. */
export function storeUsageAccounts(now: number) {
  const hour = HOUR;
  const w = (kind: string, usedPercent: number, resetsAt: number) => ({
    kind,
    usedPercent,
    resetsAt,
    limited: usedPercent >= 100,
    observedAt: now - 4 * MIN,
  });
  const check = { at: now - 4 * MIN, outcome: 'read' as const };
  const spent = (rows: [string, string, number, number][]) =>
    rows.map(([agentId, name, turns, tokens]) => ({ agentId, name, turns, tokens }));
  return [
    {
      engine: 'claude' as const,
      id: 'default',
      name: 'Studio',
      thisMac: true,
      signedIn: true,
      out: false,
      next: true,
      plan: 'max',
      windows: [w('five_hour', 18, now + 3 * hour), w('seven_day', 46, now + 76 * hour)],
      learned: ['five_hour', 'seven_day'],
      spent: spent([
        ['ostler', 'Ostler site', 31, 5_200_000],
        ['research', 'Research', 22, 2_900_000],
        ['chief', 'Chief of Staff', 14, 1_100_000],
      ]),
      check,
    },
    {
      engine: 'claude' as const,
      id: 'c2',
      name: 'Personal',
      thisMac: false,
      signedIn: true,
      out: false,
      next: false,
      plan: 'pro',
      windows: [w('five_hour', 4, now + 4 * hour), w('seven_day', 21, now + 52 * hour)],
      learned: ['five_hour', 'seven_day'],
      spent: spent([['inbox', 'Inbox', 18, 900_000]]),
      check,
    },
    {
      engine: 'codex' as const,
      id: 'default',
      name: 'Work',
      thisMac: true,
      signedIn: true,
      out: false,
      next: true,
      plan: 'pro',
      windows: [w('five_hour', 9, now + 2 * hour), w('seven_day', 33, now + 98 * hour)],
      learned: ['five_hour', 'seven_day'],
      spent: spent([['finance', 'Finance', 16, 1_400_000]]),
      check,
    },
    {
      engine: 'codex' as const,
      id: 'x2',
      name: 'Personal',
      thisMac: false,
      signedIn: true,
      out: false,
      next: false,
      plan: 'plus',
      windows: [w('five_hour', 0, now + 5 * hour), w('seven_day', 7, now + 120 * hour)],
      learned: ['five_hour', 'seven_day'],
      spent: [],
      check,
    },
  ];
}

/** `agents.accounts` for the same four, in the order turns use them. */
export function storeWallet() {
  const row = (
    engine: 'claude' | 'codex',
    id: string,
    name: string,
    thisMac: boolean,
    plan: string
  ) => ({
    id,
    engine,
    name,
    named: true,
    thisMac,
    signedIn: true,
    plan,
    out: false,
  });
  return [
    row('claude', 'default', 'Studio', true, 'Max'),
    row('claude', 'c2', 'Personal', false, 'Pro'),
    row('codex', 'default', 'Work', true, 'pro'),
    row('codex', 'x2', 'Personal', false, 'plus'),
  ];
}
