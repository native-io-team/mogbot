import type { ReactNode } from 'react';
import type { StatusTone } from '@/lib/agents';

export type { StatusTone };

/**
 * One calm pill for a state: the site's tag (a 6px pill washed in the hue),
 * with a dot of the hue and the words in ordinary ink. The hue is a status
 * role, never the accent: running is `--status-running`, waiting on you
 * `--accent-warning` (amber means needs you, only), failed `--accent-error`,
 * done `--accent-success`, and out of usage or idle a neutral wash, because a
 * limit resets by itself. The words carry the meaning; the hue only helps the
 * eye find the row (so the label reads the same to everyone).
 */
export function StatusPill({
  tone,
  children,
  title,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      className={`status-pill status-pill--${tone}${className ? ` ${className}` : ''}`}
      data-tone={tone}
      title={title}
    >
      <span className="status-pill__dot" aria-hidden="true" />
      <span className="status-pill__label">{children}</span>
    </span>
  );
}
