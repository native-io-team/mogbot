/**
 * A conversation's automatic title from the first thing the user said in it:
 * short, sentence case, the ask without the pleasantries. The Mac makes it
 * (`src-tauri/src/agents/conversation_title.rs`); this copy tidies a title
 * from a Mac on an older build, which sent the whole first line. Both are
 * held to `conversation-title-cases.json`, and both are idempotent, so a
 * title already tidied comes back as it went in.
 */

/** Longest automatic title, in characters (`AUTO_TITLE_CHARS`). Cut at a word, no "…". */
export const CONVERSATION_AUTO_TITLE_CHARS = 40;

const LEADING = [
  'i would like you to',
  "i'd like you to",
  'i want you to',
  'i need you to',
  'go ahead and',
  'quick question',
  'hey there',
  'could you please',
  'can you please',
  'would you please',
  'could you',
  'can you',
  'would you',
  'will you',
  'can u',
  "let's",
  'lets',
  'please',
  'pls',
  'plz',
  'hey',
  'hi',
  'hello',
  'okay',
  'ok',
  'so',
  'um',
  'uh',
  'alright',
  'yo',
];

const TRAILING = ['thank you', 'thanks', 'please', 'pls', 'for me'];

const DANGLING = new Set(
  'a an the and or but to of with for in on at so that my your our is are from by as into about'.split(
    ' '
  )
);

const COMMON = new Set(
  (
    'a about after again all also an and any are as at be because before but by can check could do ' +
    'does draft each every find fix for from get give go has have help her him his how if in into is ' +
    'it its just keep kind know let like look make me more most my new next no not now of on one or ' +
    'our out plan please put really see send set should so some sort start still than that the their ' +
    'them then there these they think this those to too try up us use want was we week what when ' +
    'where which while who why will with would write you your'
  ).split(' ')
);

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
const chars = (s: string) => Array.from(s);

function firstLine(text: string): string {
  let fenced = false;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !l || l.startsWith('>')) continue;
    return l;
  }
  for (const raw of text.split('\n')) {
    const l = raw.replace(/^[\s>]+/, '').trim();
    if (l && !l.startsWith('```')) return l;
  }
  return '';
}

function stripMarkdown(line: string): string {
  let s = line.replace(/^#+/, '').trimStart();
  s = s.replace(/^[-*+] /, '');
  s = s.replace(/^\d+[.)] /, '');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return s.replace(/\*\*|__|~~/g, '').replace(/[`*]/g, '');
}

function stripQuotes(line: string): string {
  const cs = chars(line);
  return cs
    .filter((c, i) => {
      if ('"“”«»‘'.includes(c)) return false;
      if (c === "'" || c === '’') return isWordChar(cs[i - 1]) && isWordChar(cs[i + 1]);
      return true;
    })
    .join('');
}

function stripLeading(line: string): string {
  let s = line.trim();
  for (;;) {
    const lower = s.toLowerCase().replace(/’/g, "'");
    const hit = LEADING.find((p) => {
      if (!lower.startsWith(p)) return false;
      const next = lower[p.length];
      return next === undefined || (!isWordChar(next) && next !== "'");
    });
    if (!hit) return s;
    const rest = chars(s)
      .slice(chars(hit).length)
      .join('')
      .replace(/^[,!:-]+/, '')
      .trim();
    if (!rest) return s;
    s = rest;
  }
}

function isOnlyFiller(s: string): boolean {
  const lower = s.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return LEADING.includes(lower) || TRAILING.includes(lower);
}

function firstSentence(line: string): string {
  const cs = chars(line);
  let start = 0;
  for (let i = 0; i < cs.length; i++) {
    if ('.?!;'.includes(cs[i]) && /\s/.test(cs[i + 1] ?? '')) {
      const sentence = cs.slice(start, i).join('').trim();
      if (stripLeading(sentence) && !isOnlyFiller(sentence)) return sentence;
      start = i + 1;
    }
  }
  return cs.slice(start).join('').trim();
}

function stripTrailing(line: string): string {
  let s = line.trim();
  for (;;) {
    const before = s;
    s = s.replace(/[.,;:!?…\-–—\s]+$/u, '');
    const lower = s.toLowerCase();
    for (const t of TRAILING) {
      if (lower.endsWith(t) && lower.length > t.length) {
        const head = chars(s)
          .slice(0, chars(s).length - chars(t).length)
          .join('');
        if (!isWordChar(head[head.length - 1])) {
          s = head.trimEnd();
          break;
        }
      }
    }
    const at = s.lastIndexOf(' ');
    if (at >= 0 && DANGLING.has(s.slice(at + 1))) s = s.slice(0, at);
    if (s === before) return s;
  }
}

function clip(line: string): string {
  const cs = chars(line);
  if (cs.length <= CONVERSATION_AUTO_TITLE_CHARS) return line;
  const cut = cs.slice(0, CONVERSATION_AUTO_TITLE_CHARS + 1).join('');
  const at = cut.lastIndexOf(' ');
  return at > 0 ? cut.slice(0, at) : cs.slice(0, CONVERSATION_AUTO_TITLE_CHARS).join('');
}

function sentenceCase(line: string): string {
  const letters = chars(line).filter((c) => /\p{L}/u.test(c));
  const shouted =
    letters.length >= 4 && letters.every((c) => c === c.toUpperCase() && c !== c.toLowerCase());
  const joined = line
    .split(' ')
    .map((w, i) => {
      if (shouted) return w.toLowerCase();
      const [first, ...rest] = chars(w);
      if (!first) return '';
      const capitalised =
        first !== first.toLowerCase() &&
        rest.length > 0 &&
        rest.every((c) => c === c.toLowerCase());
      const bare = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      return i > 0 && capitalised && COMMON.has(bare) ? w.toLowerCase() : w;
    })
    .join(' ');
  const [first, ...rest] = chars(joined);
  return first ? first.toUpperCase() + rest.join('') : '';
}

/** The title for a conversation whose first user message is `text`; empty when there's nothing to name it by. */
export function conversationAutoTitle(text: string): string {
  let line = stripQuotes(stripMarkdown(firstLine(text)));
  line = line.split(/\s+/).filter(Boolean).join(' ');
  // A title clipped by an older build ends "…"; the cut is redone here.
  line = line.replace(/[….]+$/u, '').trim();
  line = stripLeading(firstSentence(stripLeading(line)));
  line = clip(stripTrailing(line));
  return sentenceCase(stripTrailing(line));
}
