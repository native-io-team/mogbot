/**
 * Every touchable in the app tells VoiceOver and TalkBack what it is and what
 * it's called. Read from the source, so a new button can't ship silent:
 *
 * - a role (`accessibilityRole`), or `accessible={false}` for a touch target
 *   that sits inside something already announced;
 * - a name: an `accessibilityLabel`, or words of its own (a `<T>`/`<Text>`
 *   child, or an expression that renders them). An icon on its own is not a
 *   name; VoiceOver reads it as "button".
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..', 'src');
const TOUCHABLE = /^(Pressable|AnimatedPressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)$/;
/** Components that render readable words. */
const WORDS = /^(T|Text|Animated\.Text)$/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

type Attr = { name: string; value: ts.JsxAttributeValue | undefined };

function attrsOf(node: ts.JsxOpeningLikeElement): Attr[] | null {
  const out: Attr[] = [];
  for (const p of node.attributes.properties) {
    // A spread may carry the role and label; trust the component it came from.
    if (!ts.isJsxAttribute(p)) return null;
    out.push({ name: p.name.getText(), value: p.initializer });
  }
  return out;
}

/** Whether a child tree carries words a screen reader would read. */
function hasWords(children: readonly ts.JsxChild[]): boolean {
  return children.some((c) => {
    if (ts.isJsxText(c)) return c.getText().trim().length > 0;
    // `{header}`, `{line}`, `{children}`: rendered elsewhere, assumed to speak.
    if (ts.isJsxExpression(c)) return !!c.expression;
    if (ts.isJsxSelfClosingElement(c)) return WORDS.test(c.tagName.getText());
    if (ts.isJsxElement(c)) {
      return WORDS.test(c.openingElement.tagName.getText()) || hasWords(c.children);
    }
    if (ts.isJsxFragment(c)) return hasWords(c.children);
    return false;
  });
}

function problems(): string[] {
  const found: string[] = [];
  for (const file of files(SRC)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        TOUCHABLE.test(node.tagName.getText())
      ) {
        const attrs = attrsOf(node);
        if (attrs) {
          const has = (n: string) => attrs.some((a) => a.name === n);
          const hidden = attrs.some(
            (a) => a.name === 'accessible' && a.value?.getText() === '{false}'
          );
          const where = `${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          if (!hidden && !has('accessibilityRole') && !has('role')) found.push(`${where} has no role`);
          const children = ts.isJsxOpeningElement(node) ? node.parent.children : [];
          if (!hidden && !has('accessibilityLabel') && !hasWords(children)) {
            found.push(`${where} has no name (no accessibilityLabel and no words inside)`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe('touchables, to a screen reader', () => {
  it('every one has a role and a name', () => {
    expect(problems()).toEqual([]);
  });
});
