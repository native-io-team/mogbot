import { describe, expect, it } from 'vitest';
import { createStreamingSegments, toSegments } from './agentMarkdown';

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
    '',
    '> A quoted line from the brief.',
  ].join('\n');

const CODE = (i: number) =>
  `Here is the fix:\n\n\`\`\`ts\nexport function price${i}(n: number) {\n  return n * ${i};\n}\n\`\`\`\n\nAnd the CSS:\n\n\`\`\`css\n.card-${i} { gap: 24px; }\n\`\`\``;

const DOCS: Record<string, string> = {
  'a long reply': Array.from({ length: 6 }, (_, i) => (i % 3 === 2 ? CODE(i) : MD(i))).join('\n\n'),
  'a loose list split by blank lines': 'Intro\n\n- one\n\n- two\n\n- three\n\nAfter the list.',
  'indented code across a blank line': 'Para\n\n    code one\n\n    code two\n\nEnd.',
  'reference links defined at the end':
    'See [the docs][d] and [more][m].\n\nMiddle.\n\n[d]: https://a.example\n[m]: https://b.example',
  'nested quotes and a rule': '> one\n>\n> two\n\n---\n\n> three\n\nText with  \nhard break.',
  'an unclosed fence until the end': 'Start\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.',
  'raw html spanning blank lines': 'Before\n\n<div>\n\ninside\n\n</div>\n\nAfter',
  'a longer fence holding a short one':
    'Text\n\n````md\n```js\nx\n```\n\nmore\n````\n\n~~~\ntilde\n\nfence\n~~~\n\nEnd.',
  'a tight list then a paragraph then a list':
    '1. one\n2. two\n\nBetween.\n\n- a\n- b\n\n  continued in b\n\nOut.',
  'a setext heading and a lazy quote': 'Title\n===\n\n> quoted\nlazy line\n\nSub\n---\n\nEnd',
  'links, autolinks and a path across blocks':
    'See https://example.com/a and <https://b.example>.\n\nThen [x](https://c.example "t") and ~/ShipStudio/p/a.ts.\n\nDone ![img](https://d.example/i.png).',
  'carriage returns': 'One\r\n\r\nTwo\r\n\r\n- a\r\n- b\r\n\r\nThree',
  'script-ish text the sanitizer must still see':
    'Hi\n\n[click](javascript:alert(1))\n\nand `<img src=x onerror=alert(1)>` too\n\nEnd',
};

/** Feed a text the way drafts arrive: growing a few words at a time. */
function streamed(full: string, step: number) {
  const segmentsFor = createStreamingSegments();
  const words = full.match(/\S+\s*/g) ?? [full];
  const results: { text: string; got: ReturnType<typeof toSegments> }[] = [];
  for (let i = step; i < words.length + step; i += step) {
    const text = words.slice(0, i).join('');
    results.push({ text, got: segmentsFor(text) });
  }
  return results;
}

describe('createStreamingSegments', () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    // Every prefix is parsed whole for comparison: slow under a loaded run.
    it(`matches a whole parse at every step: ${name}`, { timeout: 60_000 }, () => {
      for (const step of [1, 3]) {
        for (const { text, got } of streamed(doc, step)) {
          expect(got).toEqual(toSegments(text));
        }
      }
    });
  }

  it('starts over when the text is not a continuation', () => {
    const segmentsFor = createStreamingSegments();
    segmentsFor('First reply.\n\nSecond paragraph.');
    expect(segmentsFor('Another reply entirely')).toEqual(toSegments('Another reply entirely'));
  });

  it('still sanitizes what it keeps', () => {
    const doc = DOCS['script-ish text the sanitizer must still see'];
    const steps = streamed(doc, 1);
    const last = steps[steps.length - 1].got;
    const html = last.map((s) => (s.type === 'html' ? s.html : '')).join('');
    expect(html).not.toMatch(/javascript:|<img/i);
    expect(html).toContain('&lt;img');
  });
});
