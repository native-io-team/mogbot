import type { HTMLAttributes } from 'react';

interface TypingDotsProps extends HTMLAttributes<HTMLSpanElement> {
  /** Announced to screen readers. Without one the dots are decoration (the text beside them speaks). */
  label?: string;
}

/**
 * Three dots in one calm wave: "working", wherever an agent is busy (the
 * working pill under a reply, a live bar above the composer). The phone draws
 * the same wave (`mobile/src/components/TypingDots.tsx`).
 *
 * The dots are `currentColor`, inherited like the Spinner's arc: muted in the
 * working pill, the running blue in a live bar. Every dot runs the same keyframes on the same period, offset by a
 * fixed fraction of it with a *negative* delay (styles/components/
 * typing-dots.css): all three are mid-wave from the first frame and stay
 * locked in phase. Positive delays left the later dots sitting still at full
 * strength until their turn, every time the row mounted.
 */
export function TypingDots({ label, className, ...rest }: TypingDotsProps) {
  return (
    <span
      className={['ss-typing-dots', className].filter(Boolean).join(' ')}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
      {...rest}
    >
      <span className="ss-typing-dots__dot" />
      <span className="ss-typing-dots__dot" />
      <span className="ss-typing-dots__dot" />
    </span>
  );
}
