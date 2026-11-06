/**
 * An agent's words as markdown: a finished reply, and a reply still being
 * written.
 *
 * A reply streams in as the whole text so far, every 40 ms. Three things keep
 * that smooth here, as the phone's reply already was:
 *
 * - **It is revealed at the display's pace** (`useReveal`), not in 40 ms
 *   steps: what arrived is spread over the frames until the next arrival, so
 *   the words flow instead of jumping a few at a time.
 * - **Only the block being written is redrawn.** The parser keeps finished
 *   blocks (`createStreamingSegments`), and `ProseRun` keeps their DOM: it
 *   used to set the whole reply's HTML on every delta, which rebuilt and
 *   re-laid-out every paragraph above the one growing.
 * - **The finished message carries on from where the draft had got to**
 *   (`FinishedProse`), instead of snapping the last few words in.
 *
 * @module components/agents/AgentProse
 */

import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from '@/components/icons';
import { IconButton } from '../primitives/IconButton';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useAgentsSelector } from '../../lib/agentsStore';
import { createStreamingSegments, toSegments, type Segment } from './agentMarkdown';
import { isRevealing, useReveal } from './useReveal';

const CodeBlock = memo(function CodeBlock({ text }: { text: string }) {
  const { copy, isCopied } = useCopyToClipboard();
  return (
    <div className="agent-code">
      <pre>
        <code>{text}</code>
      </pre>
      <IconButton
        variant="ghost"
        size="compact"
        tabIndex={0}
        className="agent-code__copy"
        icon={isCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        onClick={() => void copy(text)}
        aria-label={isCopied ? 'Copied' : 'Copy code'}
        title={isCopied ? 'Copied' : 'Copy'}
      />
    </div>
  );
});

/**
 * A run of prose drawn block by block: a block whose HTML is what it was
 * keeps its nodes, and only the ones from the first change on are replaced.
 * The result is the same DOM as setting the joined HTML, one wrapper and the
 * blocks as its children, so spacing and the streaming caret are unchanged.
 * The HTML is the sanitizer's output (`sanitizeMessageHtml`), as it is for
 * `dangerouslySetInnerHTML`; a <template> parses it inert.
 */
function ProseRun({ parts }: { parts: readonly string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const drawn = useRef<{ html: string; nodes: ChildNode[] }[]>([]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const before = drawn.current;
    let same = 0;
    while (same < before.length && same < parts.length && before[same].html === parts[same]) {
      same++;
    }
    for (const part of before.slice(same)) for (const node of part.nodes) node.remove();
    const now = before.slice(0, same);
    for (const html of parts.slice(same)) {
      const template = document.createElement('template');
      template.innerHTML = html;
      const nodes = Array.from(template.content.childNodes);
      el.append(template.content);
      now.push({ html, nodes });
    }
    drawn.current = now;
  }, [parts]);
  return <div ref={ref} className="agent-markdown__prose" />;
}

function ProseSegments({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((segment, i) =>
        segment.type === 'code' ? (
          <CodeBlock key={i} text={segment.text} />
        ) : segment.parts ? (
          <ProseRun key={i} parts={segment.parts} />
        ) : (
          <div
            key={i}
            className="agent-markdown__prose"
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        )
      )}
    </>
  );
}

/** Markdown prose with code blocks, shared by replies and agent-to-agent threads. */
export function Prose({ text }: { text: string }) {
  const segments = useMemo(() => toSegments(text), [text]);
  return <ProseSegments segments={segments} />;
}

/** Text revealed so far, parsed as it grows (only what changed is re-read and redrawn). */
export function GrowingProse({ text }: { text: string }) {
  const [segmentsFor] = useState(createStreamingSegments);
  const segments = useMemo(() => segmentsFor(text), [segmentsFor, text]);
  return <ProseSegments segments={segments} />;
}

/**
 * A reply still being written. It reads its own text from the store, so a
 * delta re-renders only this.
 */
export function DraftProse({ agentId, id }: { agentId: string; id: string }) {
  const text = useAgentsSelector((s) => s.drafts[agentId]?.text.trimStart() ?? '');
  return <GrowingProse text={useReveal(id, text, true)} />;
}

/**
 * A finished reply. Normally drawn whole; when it has just replaced its own
 * draft and the reveal hadn't caught up, it carries on revealing first.
 */
export function FinishedProse({ id, text }: { id: string; text: string }) {
  // Only a reply caught mid-reveal pays for the hook's frames; history doesn't.
  const [catching] = useState(() => isRevealing(id));
  if (!catching) return <Prose text={text} />;
  return <CatchingUp id={id} text={text} />;
}

function CatchingUp({ id, text }: { id: string; text: string }) {
  // The draft was revealed without its leading whitespace; so is this.
  const target = text.trimStart();
  const shown = useReveal(id, target, false);
  return shown.length < target.length ? <GrowingProse text={shown} /> : <Prose text={text} />;
}
