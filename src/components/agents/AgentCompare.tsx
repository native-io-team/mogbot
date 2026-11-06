/**
 * Before and after on a result card (`comparePages`): one compare per page
 * the agent named, a switcher between pages, and two ways to look — side by
 * side (each picture opens full size, in the chat's gallery) or a slider
 * that wipes one over the other. Captions are the agent's, else "Before" and
 * "After". A page with only one picture shows that picture.
 *
 * @module components/agents/AgentCompare
 */

import { useState, type CSSProperties } from 'react';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { AttachmentImage } from './AgentAttachments';
import { comparePageName, type Agent, type Attachment, type ComparePage } from '../../lib/agents';

type Mode = 'side' | 'slide';

const MODES = [
  { value: 'side' as const, label: 'Side by side' },
  { value: 'slide' as const, label: 'Slider' },
];

export function CompareShot({
  agent,
  file,
  caption,
  onView,
}: {
  agent: Pick<Agent, 'home'>;
  file: Attachment;
  caption: string;
  onView: (file: Attachment) => void;
}) {
  return (
    <figure className="agent-result__shot">
      <button
        type="button"
        className="agent-result__shot-image"
        onClick={() => onView(file)}
        aria-label={`View ${caption}: ${file.name}`}
        title={file.name}
      >
        <AttachmentImage agent={agent} attachment={file} />
      </button>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function Slider({
  agent,
  before,
  after,
  beforeCaption,
  afterCaption,
}: {
  agent: Pick<Agent, 'home'>;
  before: Attachment;
  after: Attachment;
  beforeCaption: string;
  afterCaption: string;
}) {
  const [at, setAt] = useState(50);
  return (
    <div
      className="agent-compare__slider"
      style={{ '--agent-compare-at': `${at}%` } as CSSProperties}
    >
      <AttachmentImage agent={agent} attachment={after} className="agent-compare__after" />
      <div className="agent-compare__before" aria-hidden>
        <AttachmentImage agent={agent} attachment={before} />
      </div>
      <span className="agent-compare__divider" aria-hidden />
      <span className="agent-compare__tag agent-compare__tag--before">{beforeCaption}</span>
      <span className="agent-compare__tag agent-compare__tag--after">{afterCaption}</span>
      <input
        type="range"
        className="agent-compare__range"
        min={0}
        max={100}
        step={1}
        value={at}
        onChange={(e) => setAt(Number(e.target.value))}
        aria-label={`Compare ${beforeCaption} and ${afterCaption}`}
        aria-valuetext={`${at}% ${beforeCaption}`}
      />
    </div>
  );
}

export function ResultCompare({
  agent,
  pages,
  onView,
}: {
  agent: Pick<Agent, 'home'>;
  pages: ComparePage[];
  onView: (file: Attachment) => void;
}) {
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>('side');
  if (pages.length === 0) return null;
  const page = pages[Math.min(index, pages.length - 1)];
  const beforeCaption = page.beforeLabel ?? 'Before';
  const afterCaption = page.afterLabel ?? 'After';
  const both = page.before && page.after;
  return (
    <section className="agent-compare" aria-label="Before and after" data-pages={pages.length}>
      {(pages.length > 1 || both) && (
        <div className="agent-compare__bar">
          {pages.length > 1 && (
            <SegmentedControl
              size="compact"
              className="agent-compare__pages"
              aria-label="Page"
              value={String(index)}
              onValueChange={(v) => setIndex(Number(v))}
              options={pages.map((p, i) => ({ value: String(i), label: comparePageName(p, i) }))}
            />
          )}
          {both && (
            <SegmentedControl
              size="compact"
              className="agent-compare__mode"
              aria-label="Compare as"
              value={mode}
              onValueChange={setMode}
              options={MODES}
            />
          )}
        </div>
      )}
      {both && mode === 'slide' ? (
        <Slider
          key={`${index}`}
          agent={agent}
          before={page.before!}
          after={page.after!}
          beforeCaption={beforeCaption}
          afterCaption={afterCaption}
        />
      ) : (
        <div className="agent-result__pair" data-single={!both || undefined}>
          {page.before && (
            <CompareShot agent={agent} file={page.before} caption={beforeCaption} onView={onView} />
          )}
          {page.after && (
            <CompareShot agent={agent} file={page.after} caption={afterCaption} onView={onView} />
          )}
        </div>
      )}
    </section>
  );
}
