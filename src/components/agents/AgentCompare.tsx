/**
 * The media on a result card. Before and after (`comparePages`): one compare
 * per page the agent named, a switcher between pages, and two ways to look —
 * side by side (each picture opens full size, in the chat's gallery) or a
 * slider that wipes one over the other. Captions are the agent's, else
 * "Before" and "After". A page with only one picture shows that picture.
 *
 * A picture clearly taller than wide is a phone screen (`isPortrait`, read
 * from the picture's own size once it loads): it is shown whole in a device
 * frame rather than cropped to a strip. The card's other pictures are a small
 * gallery (`ResultGallery`).
 *
 * @module components/agents/AgentCompare
 */

import { useState, type CSSProperties } from 'react';
import { ChevronRightIcon, ImageIcon } from '@/components/icons';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { AttachmentImage } from './AgentAttachments';
import {
  comparePageName,
  isPortrait,
  type Agent,
  type Attachment,
  type ComparePage,
} from '../../lib/agents';

type Mode = 'side' | 'slide';

const MODES = [
  { value: 'side' as const, label: 'Side by side' },
  { value: 'slide' as const, label: 'Slider' },
];

type Size = { width: number; height: number };

/** Whether a picture is a phone screen, once it has loaded. */
function useShape(): [boolean, (size: Size) => void] {
  const [portrait, setPortrait] = useState(false);
  return [portrait, (size) => setPortrait(isPortrait(size))];
}

export function CompareShot({
  agent,
  file,
  caption,
  onView,
  tagged,
}: {
  agent: Pick<Agent, 'home'>;
  file: Attachment;
  caption: string;
  onView: (file: Attachment) => void;
  /** The caption sits on the picture as a label (a before/after pair). */
  tagged?: boolean;
}) {
  const [portrait, measure] = useShape();
  return (
    <figure className="agent-result__shot" data-portrait={portrait || undefined}>
      <button
        type="button"
        className="agent-result__shot-image"
        onClick={() => onView(file)}
        aria-label={`View ${caption}: ${file.name}`}
        title={file.name}
      >
        <span className="agent-result__frame">
          <AttachmentImage agent={agent} attachment={file} onLoad={measure} />
        </span>
        {tagged && <span className="agent-result__tag">{caption}</span>}
      </button>
      {!tagged && <figcaption>{caption}</figcaption>}
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
  // The picture's own proportions, once known: the slider takes its shape.
  const [size, setSize] = useState<Size | null>(null);
  const portrait = isPortrait(size);
  return (
    <div className="agent-compare__stage" data-portrait={portrait || undefined}>
      <div
        className="agent-compare__slider"
        style={
          {
            '--agent-compare-at': `${at}%`,
            ...(size ? { '--agent-compare-ratio': `${size.width} / ${size.height}` } : {}),
          } as CSSProperties
        }
      >
        <AttachmentImage
          agent={agent}
          attachment={after}
          className="agent-compare__after"
          onLoad={setSize}
        />
        <div className="agent-compare__before" aria-hidden>
          <AttachmentImage agent={agent} attachment={before} />
        </div>
        <span className="agent-compare__divider" aria-hidden>
          <span className="agent-compare__knob">
            <ChevronRightIcon size={12} className="agent-compare__flip" />
            <ChevronRightIcon size={12} />
          </span>
        </span>
        <span className="agent-result__tag agent-compare__tag--before">{beforeCaption}</span>
        <span className="agent-result__tag agent-compare__tag--after">{afterCaption}</span>
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
    <section
      className="agent-compare"
      aria-label="Before and after"
      data-pages={pages.length}
      data-mode={both ? mode : undefined}
    >
      {(pages.length > 1 || both) && (
        <div className="agent-compare__bar">
          {pages.length > 1 ? (
            <SegmentedControl
              size="compact"
              className="agent-compare__pages"
              aria-label="Page"
              value={String(index)}
              onValueChange={(v) => setIndex(Number(v))}
              options={pages.map((p, i) => ({ value: String(i), label: comparePageName(p, i) }))}
            />
          ) : (
            <span className="agent-compare__label">
              <ImageIcon size={14} />
              Before and after
            </span>
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
            <CompareShot
              agent={agent}
              file={page.before}
              caption={beforeCaption}
              onView={onView}
              tagged
            />
          )}
          {page.after && (
            <CompareShot
              agent={agent}
              file={page.after}
              caption={afterCaption}
              onView={onView}
              tagged
            />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The card's other pictures, as a small gallery: one shows wide, two or more
 * sit in a grid of thumbnails, each opening full size in the chat's gallery.
 */
export function ResultGallery({
  agent,
  images,
  onView,
}: {
  agent: Pick<Agent, 'home'>;
  images: { file: Attachment; caption: string }[];
  onView: (file: Attachment) => void;
}) {
  if (images.length === 0) return null;
  return (
    <ul
      className="agent-result__gallery"
      aria-label={images.length === 1 ? 'Picture' : `${images.length} pictures`}
      data-count={Math.min(images.length, 3)}
    >
      {images.map(({ file, caption }, i) => (
        <li key={`${i}:${file.path}`}>
          <CompareShot agent={agent} file={file} caption={caption} onView={onView} />
        </li>
      ))}
    </ul>
  );
}
