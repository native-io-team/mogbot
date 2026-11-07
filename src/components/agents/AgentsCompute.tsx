/**
 * Total compute: every account at once, as the usage popover's and Settings
 * → Usage's top. One sentence on what there is room on, naming the accounts
 * read ("Room now on Claude · This Mac."), the run-out estimate right after
 * it in the warning ink with what it rests on, and, only with two or more
 * accounts read, how many there are and each kind of limit across them.
 * Then each account as one compact row, most room first; the bar a pace
 * line is about is tinted to match it.
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
          {view.estimate && (
            <span className="agents-compute__pace-text"> {view.estimate.text}</span>
          )}
        </p>
        {view.estimate && <p className="agents-compute__muted">{view.estimate.basis}</p>}
        {view.summary && <p className="agents-compute__muted">{view.summary}</p>}
      </div>
      {view.windows.length > 0 && (
        <dl className="agents-compute__windows">
          {view.windows.map((w) => (
            <div className="agents-compute__window" key={w.key} data-tone={w.tone}>
              <dt className="agents-compute__window-name">{w.label}</dt>
              <dd className="agents-compute__window-room">{w.text}</dd>
            </div>
          ))}
        </dl>
      )}
      <ul className="agents-compute__rows" aria-label="Accounts">
        {view.rows.map((r) => (
          <AccountRow key={r.key} row={r} />
        ))}
      </ul>
    </div>
  );
}

function AccountRow({ row: r }: { row: ComputeRow }) {
  const meters = [r.session, r.weekly].filter((m): m is UsageMeter => m !== null);
  return (
    <li className="agents-compute__row" data-next={r.next || undefined}>
      <div className="agents-compute__row-head">
        <span className="agents-compute__name">{r.title}</span>
        {r.tags.length > 0 && <span className="agents-compute__muted">{r.tags.join(' · ')}</span>}
      </div>
      {r.state && (
        <span className="agents-compute__state" data-tone={r.tone}>
          {r.state}
        </span>
      )}
      {meters.length > 0 && (
        <div className="agents-compute__meters">
          {meters.map((m) => (
            <Bar key={m.key} meter={m} />
          ))}
        </div>
      )}
      {r.extra.map((m) => (
        <Bar key={m.key} meter={m} />
      ))}
      {r.pace && (
        <span className="agents-compute__pace" title={r.pace.basis}>
          <span className="agents-compute__pace-text">{r.pace.text}</span>
          <span className="agents-compute__muted">{r.pace.basis}</span>
        </span>
      )}
    </li>
  );
}

/** "5-hour  38%", a thin bar, "Resets at 3:20 PM". */
function Bar({ meter }: { meter: UsageMeter }) {
  return (
    <div className="agents-compute__meter" data-tone={meter.tone}>
      <div className="agents-compute__meter-head">
        <span>{meter.label}</span>
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
      <span className="agents-compute__muted">{meter.detail}</span>
    </div>
  );
}
