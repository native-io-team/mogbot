/**
 * Agent prose as markdown: the parser, and how a reply becomes segments
 * (sanitized HTML runs, and code blocks rendered as components so they can
 * carry Copy).
 *
 * A reply still being written arrives as the whole text so far, every 40 ms.
 * Parsing all of it each time is quadratic over the reply, and it was a third
 * of the work of streaming one. `createStreamingSegments` keeps what it has
 * already parsed: a top-level block followed by a blank line can't change any
 * more, so only the text after the last one is lexed, rendered and sanitized
 * again. What it returns is what `toSegments` returns for the same text; the
 * finished message is parsed whole anyway.
 *
 * @module components/agents/agentMarkdown
 */

import { Marked, type Token, type Tokens, type TokensList } from 'marked';
import { imageLinkLabel, sanitizeMessageHtml } from '../../lib/safeHtml';
import { isCodePath, PROSE_PATH } from '../../lib/agents';
import { columnAlign } from '../../../packages/companion-protocol/src/tables';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const pathLink = (path: string, inner: string) =>
  `<a href="${escapeHtml(encodeURI(path))}" class="agent-path" title="${escapeHtml(path)}">${inner}</a>`;

/**
 * Agent prose. Images become link chips (see lib/safeHtml): a remote image
 * would load inside the app webview from wherever the agent pointed it. A local
 * path, written out or in `code`, becomes a link that opens it.
 */
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    image({ href, text }) {
      const link = `<a class="md-image-link" href="${escapeHtml(encodeURI(href))}">`;
      return `${link}${escapeHtml(imageLinkLabel(href, text))}</a>`;
    },
    codespan({ text }) {
      return isCodePath(text) ? pathLink(text.trim(), `<code>${escapeHtml(text)}</code>`) : false;
    },
  },
  extensions: [
    {
      name: 'localPath',
      level: 'inline',
      start: (src) => {
        const at = src.search(PROSE_PATH);
        return at < 0 ? undefined : at;
      },
      tokenizer(src) {
        if (this.lexer.state.inLink) return undefined;
        const match = new RegExp(`^${PROSE_PATH.source}`).exec(src);
        return match ? { type: 'localPath', raw: match[0], path: match[0] } : undefined;
      },
      renderer: (token) => pathLink(String(token.path), escapeHtml(String(token.path))),
    },
  ],
});

/**
 * A table's figures right-aligned: a column whose body is all figures gets
 * `align="right"` (and tabular figures, in CSS), unless the author aligned
 * it. The phone's Markdown uses the same rule (`columnAlign`).
 */
function alignFigures(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type !== 'table') continue;
    const table = token as Tokens.Table;
    const align = columnAlign(
      table.align,
      table.rows.map((row) => row.map((cell) => cell.text))
    );
    table.align = align;
    for (const row of [table.header, ...table.rows]) {
      row.forEach((cell, c) => {
        cell.align = align[c] ?? null;
      });
    }
  }
}

export type Segment =
  /**
   * `parts`, from the streaming parser only: the run's top-level blocks, one
   * HTML string each (joined, they are `html`). A run drawn from its parts
   * keeps the DOM of every block that didn't change (`ProseRun`).
   */
  { type: 'html'; html: string; parts?: string[] } | { type: 'code'; text: string; lang?: string };

/** Prose renders as sanitized HTML; code blocks render as components, so they can carry Copy. */
export function toSegments(text: string): Segment[] {
  const tokens = markdown.lexer(text);
  alignFigures(tokens);
  const segments: Segment[] = [];
  let run: Token[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const list = Object.assign(run, { links: tokens.links }) as TokensList;
    segments.push({ type: 'html', html: sanitizeMessageHtml(markdown.parser(list)) });
    run = [];
  };
  for (const token of tokens) {
    if (token.type === 'code') {
      flush();
      const code = token as Tokens.Code;
      segments.push({ type: 'code', text: code.text, lang: code.lang || undefined });
    } else {
      run.push(token);
    }
  }
  flush();
  return segments;
}

/** One top-level token, rendered: what `toSegments` would make of it inside a run. */
type Piece = Segment;

function renderPiece(token: Token, links: TokensList['links']): Piece {
  if (token.type === 'code') {
    const code = token as Tokens.Code;
    return { type: 'code', text: code.text, lang: code.lang || undefined };
  }
  const list = Object.assign([token], { links }) as TokensList;
  return { type: 'html', html: sanitizeMessageHtml(markdown.parser(list)) };
}

/** Consecutive HTML pieces are one run, as in `toSegments`; each keeps its own part. */
function joinPieces(pieces: Piece[]): Segment[] {
  const segments: Segment[] = [];
  let html: string[] | null = null;
  const flush = () => {
    if (html) segments.push({ type: 'html', html: html.join(''), parts: html });
    html = null;
  };
  for (const piece of pieces) {
    if (piece.type === 'code') {
      flush();
      segments.push(piece);
    } else {
      (html ??= []).push(piece.html);
    }
  }
  flush();
  return segments;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A block that a blank line ends for good. Lists (a later item joins them,
 * and can loosen the whole list), indented code (continues past blank lines)
 * and raw HTML (some kinds span blank lines) are never treated as finished.
 */
function closedByBlankLine(token: Token): boolean {
  switch (token.type) {
    case 'paragraph':
    case 'heading':
    case 'table':
    case 'hr':
    case 'blockquote':
      return true;
    case 'code':
      return FENCE.test(token.raw);
    default:
      return false;
  }
}

/**
 * How many leading tokens can't change whatever text follows them. The blank
 * line must have something after it: at the very end it can hold the start
 * of the next line (its indentation, say), which belongs to what comes next.
 */
function finishedCount(tokens: Token[]): number {
  for (let k = tokens.length - 2; k >= 1; k--) {
    if (tokens[k].type === 'space' && closedByBlankLine(tokens[k - 1])) return k + 1;
  }
  return 0;
}

/**
 * Segments for a growing text, reusing the finished blocks of the last call.
 * Text that isn't a continuation of the last (a new reply) starts over. A
 * reference-style link definition anywhere can reach back into earlier
 * blocks, and raw HTML is only well-formed sanitized as a run, so a text with
 * either is parsed whole every time.
 */
export function createStreamingSegments(): (text: string) => Segment[] {
  let src = '';
  let pieces: Piece[] = [];
  let whole = false;
  return (text) => {
    if (!text.startsWith(src)) {
      src = '';
      pieces = [];
      whole = false;
    }
    if (whole) return toSegments(text);
    const tail = text.slice(src.length);
    const tokens = markdown.lexer(tail);
    alignFigures(tokens);
    if (Object.keys(tokens.links).length > 0 || tokens.some((t) => t.type === 'html')) {
      whole = true;
      return toSegments(text);
    }
    const done = finishedCount(tokens);
    let raw = '';
    for (let i = 0; i < done; i++) raw += tokens[i].raw;
    // Only when the tokens account for the text exactly; otherwise nothing is kept.
    const keep = done > 0 && tail.startsWith(raw) ? done : 0;
    const finished = tokens.slice(0, keep).map((t) => renderPiece(t, tokens.links));
    const rest = tokens.slice(keep).map((t) => renderPiece(t, tokens.links));
    if (keep > 0) {
      src += raw;
      pieces = [...pieces, ...finished];
    }
    return joinPieces([...pieces, ...rest]);
  };
}
