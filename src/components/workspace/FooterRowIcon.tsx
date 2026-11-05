/**
 * The icon at the start of a sidebar footer status row (Phone, Remote): the
 * same line icon, size and column as the Settings gear below them, with a
 * small status dot on its corner when the thing is on. One component, so the
 * rows can't drift apart again (Remote once had a bare 10px dot with a halo
 * where the others had an icon).
 *
 * The dot is status, never accent: green on, amber warning, red stopped.
 *
 * @module components/workspace/FooterRowIcon
 */

import type { ReactNode } from 'react';

export type FooterRowStatus = 'off' | 'ok' | 'warn' | 'down';

export function FooterRowIcon({ icon, status }: { icon: ReactNode; status: FooterRowStatus }) {
  return (
    <span className="footer-row-icon" data-status={status}>
      {icon}
      {status !== 'off' && <span className="footer-row-icon__badge" aria-hidden />}
    </span>
  );
}
