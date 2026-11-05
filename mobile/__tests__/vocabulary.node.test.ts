/**
 * One word per idea, the same as the desk's (docs/agents.md, "Lines, cards
 * and bars"): every string a person can read in the app, read out of the
 * source, held to that vocabulary. The banned list is the words the desk
 * stopped using; the snapshot is every sentence that uses one of the agreed
 * words, so a rewording shows up in review instead of drifting.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** What a template says, with each `${…}` as "…". */
function templateText(node: ts.TemplateExpression): string {
  return node.head.text + node.templateSpans.map((s) => `…${s.literal.text}`).join('');
}

/**
 * Words a person reads: JSX text, and string literals that are prose (a
 * space in them, or a capitalised word). Identifiers, keys, routes, method
 * names and comparisons ('needs_decision', '/session/[id]', 'sessions.start')
 * are neither, and imports and type positions are skipped outright.
 */
function userStrings(): { at: string; text: string }[] {
  const found: { at: string; text: string }[] = [];
  for (const path of files(SRC)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const at = (node: ts.Node) =>
      `${relative(SRC, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const prose = (text: string) =>
      /[A-Za-z]/.test(text) && (/\s/.test(text.trim()) || /^[A-Z][a-z]/.test(text));
    const visit = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isLiteralTypeNode(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node)
      )
        return;
      if (ts.isJsxText(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim();
        if (text) found.push({ at: at(node), text });
      } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const parent = node.parent;
        const isKey =
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          ts.isElementAccessExpression(parent) ||
          (ts.isCallExpression(parent) &&
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === 'require');
        if (!isKey && prose(node.text)) found.push({ at: at(node), text: node.text });
      } else if (ts.isTemplateExpression(node)) {
        const text = templateText(node);
        if (prose(text)) found.push({ at: at(node), text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const strings = userStrings();

/** The desk's retired words, and why each went. */
const BANNED: [RegExp, string][] = [
  [/\bsessions?\b/i, '"conversation" (an agent\'s) or "task" (a project\'s), never "session"'],
  [/Waiting for your decision/i, '"Needs your OK"'],
  [/via connector/i, 'just "From Grok"'],
  [/\(import\)/i, '"Bringing in agents from Grok"'],
  [/Claude Code \d|Codex \d|…\s?·\s?Claude Code/, 'a task, never an engine and a tab number'],
  [/\btake-?overs?\b(?! \w)|\btake-over\b/i, 'the verbs Take over / Hand back, never the noun'],
  [/\bDenied\b/, '"Declined", as the desk words an answered request'],
  [/on the card|card above|the card below/i, 'a bar or a line never points at "the card"'],
  [/this computer/i, '"Mac", as the desk says it'],
  [/\bexit code\b/i, 'no exit codes in anything a person reads'],
  [
    /^Open task$|^Open project$|^See changes$|^Open preview$/,
    '"Open in <project>", "Review changes", "Preview"',
  ],
  [/Being driven on your Mac/, '"You’re driving <name> on your Mac"'],
  [/Keep into /, '"Keep there too": no version names'],
];

describe('the words a person reads', () => {
  it('are read out of the source (the scan finds the app’s own sentences)', () => {
    const all = strings.map((s) => s.text);
    // If these vanish the scan is broken, not the app clean.
    expect(all).toContain('Needs your OK');
    expect(all).toContain('Allow');
    expect(all).toContain('Deny');
    expect(all.some((t) => t.startsWith('Declined'))).toBe(true);
  });

  it.each(BANNED)('never say %s', (pattern, instead) => {
    const hits = strings.filter((s) => pattern.test(s.text)).map((s) => `${s.at}: ${s.text}`);
    expect({ instead, hits }).toEqual({ instead, hits: [] });
  });

  it('use the agreed words the way the snapshot holds', () => {
    const AGREED =
      /Needs your OK|\bAllow\b|\bDeny\b|Declined|\brequest\b|\bcopy of\b|conversation|Take over|Hand back|hand .* back|driving|\bMac\b|logins|Review changes|Preview|Open in|[Rr]outine|\b[Tt]ask\b|Keep changes|Keep there too|Discard/;
    const used = [...new Set(strings.map((s) => s.text).filter((t) => AGREED.test(t)))].sort();
    expect(used).toMatchSnapshot();
  });
});
