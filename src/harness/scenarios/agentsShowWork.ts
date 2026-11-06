/**
 * Agents showing their work: a visual result as one card (a compare per
 * page, a page switcher, side by side or a slider), a checkpoint partway
 * through, a reply's links to servers on this Mac (one the app knows, one it
 * doesn't), the turn's progress lines folded into its timeline as notes, and
 * the full-size viewer as a gallery of the whole chat. Fictional throughout;
 * the pictures are the demo home's own (`harness/agents-demo`).
 */

import type { Scenario } from '../types';
import { HARNESS_ROOT } from './base';
import { AGENTS_TAB, MIN, TEAM, messagesFor, msg, now, overview, status } from './agents';

const SITE = `${HARNESS_ROOT}/acme-marketing`;
const COPY_PATH = `${HARNESS_ROOT}/.worktrees/acme-marketing/acme-site-redesign-41ac`;

const pic = (dir: string, name: string) => ({
  name,
  path: `attachments/${dir}/${name}`,
  mime: 'image/jpeg',
  size: 20_000,
});

const PRICING_BEFORE = pic('m-res1', 'before.jpg');
const PRICING_AFTER = pic('m-res1', 'after.jpg');
const HERO_AFTER = pic('m-att1', 'Hero crop.jpg');
const FOOTER_BEFORE = pic('m-att1', 'Pricing on mobile.jpg');
const FOOTER_AFTER = pic('m-att1', 'Footer links.jpg');

const acme = (o: Record<string, unknown>) => ({ agentId: 'acme', ...o });

const steps = (startMin: number, list: [number, string, string][]) => ({
  startedAt: now - startMin * MIN,
  endedAt: now - (startMin - 6) * MIN,
  stepCount: list.length,
  fileCount: 3,
  files: ['Hero.tsx', 'PricingTable.tsx', 'Footer.tsx'],
  steps: list.map(([s, kind, label]) => ({ at: now - startMin * MIN + s * 1000, kind, label })),
});

const CHECKPOINT = {
  id: 'res-redesign',
  version: 1,
  checkpoint: true,
  title: 'Redesign: pricing first',
  summary:
    'The pricing page is done in the new style. Before I carry it to the other pages: the cards stack on phones and the badge moved beside the plan name.',
  project: SITE,
  items: [
    { kind: 'file', file: PRICING_BEFORE, role: 'before', page: 'Pricing' },
    { kind: 'file', file: PRICING_AFTER, role: 'after', page: 'Pricing' },
  ],
  checked: ['Looked at it at 375px and 1280px'],
};

const FINAL = {
  ...CHECKPOINT,
  version: 2,
  checkpoint: undefined,
  title: 'Redesign across the site',
  summary:
    'Pricing, the hero and the footer are in the new style. The hero had no picture before (it was text only), so there is just the new one.',
  changes: 'Carried the pricing style to the hero and footer',
  items: [
    { kind: 'file', file: PRICING_BEFORE, role: 'before', page: 'Pricing' },
    {
      kind: 'file',
      file: PRICING_AFTER,
      role: 'after',
      page: 'Pricing',
      label: 'After · cards stack',
    },
    { kind: 'file', file: HERO_AFTER, role: 'after', page: 'Hero' },
    { kind: 'file', file: FOOTER_BEFORE, role: 'before', page: 'Footer' },
    { kind: 'file', file: FOOTER_AFTER, role: 'after', page: 'Footer' },
  ],
  checked: ['pnpm build passes', 'Each page at 375px and 1280px'],
  notVerified: ['Safari on a real iPhone'],
};

const NOTES: [number, string, string][] = [
  [2, 'note', 'Starting the previews'],
  [30, 'command', 'Ran pnpm dev'],
  [60, 'screenshot', 'Took a screenshot of acme-marketing'],
  [70, 'note', 'Checking they rendered'],
  [120, 'edit', 'Edited Hero.tsx'],
  [180, 'edit', 'Edited Footer.tsx'],
  [240, 'screenshot', 'Took a screenshot of acme-marketing'],
  [250, 'note', 'Screenshots are done'],
];

const CHAT = [
  msg('user', 'Show me where the redesign is.', 40, acme({ attachments: [] })),
  msg(
    'agent',
    CHECKPOINT.summary,
    36,
    acme({
      id: 'm-check',
      attachments: [PRICING_BEFORE, PRICING_AFTER],
      result: CHECKPOINT,
    })
  ),
  msg(
    'agent',
    'Both are running: the live site and my copy with the changes.',
    30,
    acme({
      id: 'm-links',
      localLinks: [
        {
          url: 'http://localhost:3401/',
          label: 'The redesign',
          port: 3401,
          path: COPY_PATH,
          project: SITE,
          copy: true,
        },
        { url: 'http://localhost:9230/', label: 'localhost:9230', port: 9230 },
      ],
    })
  ),
  msg(
    'agent',
    FINAL.summary,
    24,
    acme({
      id: 'm-final',
      attachments: [PRICING_BEFORE, PRICING_AFTER, HERO_AFTER, FOOTER_BEFORE, FOOTER_AFTER],
      result: FINAL,
      work: steps(30, NOTES),
    })
  ),
];

const team = () =>
  overview(TEAM.map((a) => (a.id === 'acme' ? { ...a, status: status('idle') } : a)));

const commands = (chat: unknown[]) => ({
  agents_overview: team(),
  agents_messages: (args: Record<string, unknown>) =>
    args.agentId === 'acme' ? chat : messagesFor(args),
});

const open = { click: '[data-agent-id="acme"]' };

export const agentsShowWorkScenarios: Scenario[] = [
  {
    id: 'agents-visual-checkpoint',
    title: 'Agents — a checkpoint card partway through visual work',
    looksRightWhen:
      'Acme Site’s chat ends on one result card titled “Redesign: pricing first” with a small muted “Partway through” chip in its header. Under the summary, two screenshots side by side captioned Before and After, and above them a “Side by side · Slider” segmented control (no page switcher: one page). Actions: Preview, Test it, Ask for changes — neutral, not accent.',
    requires: '.agent-result__checkpoint',
    openSelector: AGENTS_TAB,
    steps: [open],
    commands: commands(CHAT.slice(0, 2)),
  },
  {
    id: 'agents-visual-links',
    title: 'Agents — a reply’s links to servers on this Mac',
    looksRightWhen:
      'Under “Both are running…”, on their own lines against the left edge, two neutral rows: a globe, “The redesign” over “A copy of acme-marketing”, and Preview; then a screen icon, “localhost:9230” over “Running on this Mac”, and Open. No raw http://localhost links in the bubble.',
    requires: '.agent-local-links',
    openSelector: AGENTS_TAB,
    steps: [open],
    commands: commands(CHAT.slice(0, 3)),
  },
  {
    id: 'agents-visual-result',
    title: 'Agents — visual work as one card, with local links and a folded timeline',
    looksRightWhen:
      'The checkpoint is folded to one line (“… · v1 · earlier version”). A reply “Both are running…” has two rows under it: “The redesign / A copy of acme-marketing” with a Preview action, and “localhost:9230 / Running on this Mac · localhost:9230” with Open. No raw localhost links in the bubble. The final card (v2) has a “Pricing · Hero · Footer” page switcher and “Side by side · Slider”; Pricing shows Before and “After · cards stack”. Its folded “Worked …” line is under the card; open, it lists italic progress notes (“Starting the previews”, “Checking they rendered”, “Screenshots are done”) among the steps, not as chat bubbles.',
    requires: '.agent-compare__pages',
    openSelector: AGENTS_TAB,
    steps: [open, { click: '[data-message-ids="m-final"] .agent-work__toggle' }],
    commands: commands(CHAT),
  },
  {
    id: 'agents-visual-slider',
    title: 'Agents — the compare as a slider, on the Footer page',
    looksRightWhen:
      'The final card shows the Footer page selected in the switcher and Slider selected: one picture area with the before on the left of a thin vertical divider at the middle and the after on its right, small “Before” and “After” tags in the top corners.',
    requires: '.agent-compare__slider',
    openSelector: AGENTS_TAB,
    steps: [
      open,
      { click: '.agent-compare__pages button:nth-child(3)' },
      { click: '.agent-compare__mode button:nth-child(2)' },
    ],
    commands: commands(CHAT),
  },
  {
    id: 'agents-visual-gallery',
    title: 'Agents — the full-size viewer is a gallery of the whole chat',
    looksRightWhen:
      'A modal over the chat titled “Hero · After” shows that picture large, with “3 of 5” in the header beside Open and Show in Finder (the chat holds five distinct pictures: the checkpoint’s two, which the final card repeats, and three more), and ← → buttons either side of the picture, both enabled. Under the picture, its file name “Hero crop.jpg” in muted caption type.',
    requires: '.agent-lightbox__counter',
    openSelector: AGENTS_TAB,
    steps: [
      open,
      { click: '.agent-compare__pages button:nth-child(2)' },
      { click: '.agent-compare .agent-result__shot button' },
    ],
    commands: commands(CHAT),
  },
];
