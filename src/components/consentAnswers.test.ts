import { describe, expect, it } from 'vitest';

/**
 * "Answers are neutral" (docs/design-system.md, The accent), outside Agents.
 *
 * `agents/approvalNeutral.test.tsx` holds the Agents cards by rendering them.
 * This scans every other component's source instead, so a consent prompt added
 * anywhere on the Projects side is caught without a test of its own: the
 * affirmative answer to a request (Allow, Approve, Keep running, Start dev
 * server…) is `variant="strong"`, never the accent. The accent is whatever the
 * user picked for the Chief — red is in the palette — and a red Allow reads as
 * the destructive choice.
 */

const sources = import.meta.glob<string>(['./**/*.tsx', '!./agents/**', '!./**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Labels that answer a request rather than start something. */
const AFFIRMATIVE =
  /^(allow|always allow|approve|accept|grant|trust|yes\b|keep running|keep changes|start dev server)/i;

interface ButtonUse {
  file: string;
  props: string;
  label: string;
}

/** Every `<Button …>label</Button>` with a literal label. */
function buttons(file: string, source: string): ButtonUse[] {
  const found: ButtonUse[] = [];
  const re = /<Button\b([^>]*?(?:\{[^}]*\}[^>]*?)*)>([^<{]*)<\/Button>/g;
  for (const match of source.matchAll(re)) {
    const label = match[2].replace(/\s+/g, ' ').trim();
    if (label) found.push({ file, props: match[1], label });
  }
  return found;
}

const all = Object.entries(sources).flatMap(([file, source]) => buttons(file, source));

describe('consent answers outside Agents are neutral', () => {
  it('the scan sees the app’s buttons', () => {
    // A broken glob or regex would make every check below vacuous.
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(all.length).toBeGreaterThan(100);
  });

  it('no affirmative answer takes the accent', () => {
    const offenders = all
      .filter((b) => AFFIRMATIVE.test(b.label) && /variant="primary"/.test(b.props))
      .map((b) => `${b.file}: "${b.label}"`);
    expect(offenders).toEqual([]);
  });

  it('every marked answer (data-allow) is strong', () => {
    const marked = all.filter((b) => /\bdata-allow\b/.test(b.props));
    for (const b of marked) {
      expect(b.props, `${b.file}: "${b.label}"`).toMatch(/variant="strong"/);
    }
  });

  // The ones the r9 audit found, held by name so a relabel can't slip past the
  // word list above.
  const known: [string, string][] = [
    ['./preview/ThumbnailConsentModal.tsx', 'Allow thumbnails'],
    ['./QuitConfirmModal.tsx', 'Keep running in background'],
    ['./preview/DevServerConsentPrompt.tsx', 'Start dev server'],
  ];
  for (const [file, label] of known) {
    it(`${file}: “${label}” is marked and strong`, () => {
      const b = all.find((x) => x.file === file && x.label === label);
      expect(b, `${file} still offers “${label}”`).toBeDefined();
      expect(b!.props).toMatch(/\bdata-allow\b/);
      expect(b!.props).toMatch(/variant="strong"/);
    });
  }
});
