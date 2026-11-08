/**
 * Total compute: every account at once, as the usage popover's and Settings
 * → Usage's top. Read top-down: one short headline on whether agents can
 * keep working (and, with no room, when they can again), the Mac's estimate
 * across accounts when it sent one, then each account with a reading as its
 * own card, one row per limit: name and %, its bar, when it resets, and that
 * limit's pace estimate right under the bar it is about. Accounts with
 * nothing to draw (out of usage, not signed in, not read) follow in one
 * quiet list.
 *
 * The words are the phone's (`companion-protocol/usageSheet.ts`
 * `computeView`), so the two never disagree. Room is only what a reading
 * said; an account without one says why, in the Mac's words.
 *
 * @module components/agents/AgentsCompute
 */

import type { CSSProperties } from 'react';
import type { ComputeRow, ComputeView, UsageMeter } from '../../lib/agentsUsage';

export function ComputeTotal({ view }: { view: ComputeView }) {
  return (
    <div className="agents-compute">
      <div className="agents-compute__top">
        <p className="agents-compute__headline" data-tone={view.tone}>
          {view.headline}
        </p>
        {view.detail && <p className="agents-compute__detail">{view.detail}</p>}
        {view.estimate && <Pace pace={view.estimate} />}
      </div>
      {view.rows.length > 0 && (
        <ul className="agents-compute__cards" aria-label="Accounts">
          {view.rows.map((r) => (
            <AccountCard key={r.key} row={r} />
          ))}
        </ul>
      )}
      {view.quiet.length > 0 && (
        <ul className="agents-compute__quiet" aria-label="Accounts without room or a reading">
          {view.quiet.map((r) => (
            <li className="agents-compute__quiet-row" key={r.key}>
              <span className="agents-compute__quiet-name">{r.title}</span>
              {r.state && <span className="agents-compute__quiet-state">{r.state}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccountCard({ row: r }: { row: ComputeRow }) {
  const meters = [r.session, r.weekly, ...r.extra].filter((m): m is UsageMeter => m !== null);
  return (
    <li className="agents-compute__row" data-next={r.next || undefined}>
      <div className="agents-compute__row-head">
        <span className="agents-compute__name">{r.title}</span>
        {r.tags.length > 0 && <span className="agents-compute__tags">{r.tags.join(' · ')}</span>}
      </div>
      {meters.map((m) => (
        <Bar key={m.key} meter={m} />
      ))}
    </li>
  );
}

/** "5-hour  38%", its bar, "Resets at 3:20 PM", then its pace when there is one. */
function Bar({ meter }: { meter: UsageMeter }) {
  return (
    <div className="agents-compute__meter" data-tone={meter.tone}>
      <div className="agents-compute__meter-head">
        <span className="agents-compute__meter-name">{meter.label}</span>
        <span className="agents-compute__figure">{meter.percent}%</span>
      </div>
      <div
        className="agents-compute__bar"
        role="meter"
        aria-label={meter.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={meter.percent}
      >
        <span
          className="agents-compute__fill"
          style={{ '--agents-compute-fill': `${meter.percent}%` } as CSSProperties}
        />
      </div>
      <span className="agents-compute__reset">{meter.detail}</span>
      {meter.pace && <Pace pace={meter.pace} />}
    </div>
  );
}

/** An estimate, said as one: the line in the warning ink, what it rests on quietly under it. */
function Pace({ pace }: { pace: NonNullable<UsageMeter['pace']> }) {
  return (
    <span className="agents-compute__pace">
      <span className="agents-compute__pace-text">{pace.text}</span>
      <span className="agents-compute__basis">{pace.basis}</span>
    </span>
  );
}
