/**
 * Fidelity — the panel that makes "it still looks like the site" checkable.
 *
 * The old `webflow-to-code` plugin ended at a markdown brief. Nothing in it
 * ever compared the result to the original, which meant the one property a
 * migration is judged on was the one property nobody measured. This panel is
 * the other end of that: a number per template per breakpoint, the picture
 * that produced each number, and the record of the loop that moved them.
 *
 * The loop it reports on is:
 *
 *     build → compare → fix → compare → …
 *
 * and the agent drives it. The panel is where a person checks on it, decides
 * the remaining gap is acceptable, or spots that the fix at 1440 broke 767.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { ComparisonViewer } from './ComparisonViewer';
import { FidelityMatrix } from './FidelityMatrix';
import { MigrationStatusView } from './MigrationStatusView';
import { useAsyncState } from '@/hooks/useAsyncState';
import {
  buildResumePrompt,
  initMigration,
  fidelityBand,
  FIDELITY_BAND_LABEL,
  loadFidelityRun,
  loadMigrationStatus,
  runScore,
  type FidelityRun,
  type MigrationStatus,
} from '@/lib/migration';
import { queueHandoff } from '@/lib/promptHandoff';
import { getDevServerPort } from '@/lib/project';
import { logger } from '@/lib/logger';
import { useOptionalToast } from '../../contexts/ToastContext';

interface FidelityPanelProps {
  /** The open project. Everything shown is read out of its `.shipstudio/`. */
  projectPath: string;
}

export function FidelityPanel({ projectPath }: FidelityPanelProps) {
  const {
    data: run,
    isLoading,
    error,
    execute,
  } = useAsyncState<FidelityRun, [string]>(loadFidelityRun);
  // Loaded separately, and allowed to fail on its own: the agent's account of
  // the work and the measurements of it are different artefacts, and one being
  // absent is not a reason to show neither.
  const { data: status, execute: loadStatus } = useAsyncState<MigrationStatus | null, [string]>(
    loadMigrationStatus
  );
  const [selected, setSelected] = useState<{ template: string; breakpoint: number } | null>(null);
  const toast = useOptionalToast();

  /**
   * Hand the migration back to an agent in a new terminal.
   *
   * The state is already on disk, so this carries no summary of it — only the
   * instruction to go and read it. A prompt that restated the progress would
   * be a second source of truth, and the stale one would win whenever the
   * panel was open before the agent's last write.
   */
  const resume = async () => {
    if (!status) return;
    // Refresh the measuring tools first.
    //
    // They are written into the project when it is created and never touched
    // again, so a migration started last week keeps whatever version of the
    // engine it was born with — including bugs fixed since. `init_migration`
    // is idempotent and leaves the status file alone, so this is the natural
    // moment to bring the project up to date: the agent is about to depend on
    // those tools again.
    //
    // A failure here is not fatal. The existing copy still works, and losing
    // the hand-off over a refresh would be a worse trade than running on a
    // slightly older engine.
    try {
      await initMigration(projectPath, status.sourceUrl);
    } catch (err) {
      logger.warn('[Migration] Could not refresh the measuring tools', {
        error: String(err),
      });
    }
    // The port the project is configured to serve on, so the agent is not
    // guessing at where its own rebuild lives. Absent for a project that has
    // never had one set, and the prompt's fallback covers that.
    const port = await getDevServerPort(projectPath).catch(() => null);
    const rebuildUrl = port ? `http://localhost:${port}/` : undefined;
    queueHandoff(projectPath, buildResumePrompt(status.sourceUrl, rebuildUrl));
    toast?.showToast('Picking the migration back up in a new terminal', 'info');
  };

  useEffect(() => {
    void loadStatus(projectPath);
    void execute(projectPath).then((loaded) => {
      if (!loaded) return;
      // Open on the worst cell rather than on nothing. The panel's job is to
      // show where the rebuild is wrong, and making someone hunt for that in a
      // grid before they see anything buries the finding under a chore.
      const worst = loaded.templates
        .flatMap((t) => (t.status === 'compared' ? t.breakpoints.map((b) => ({ t, b })) : []))
        .sort((x, y) => x.b.score - y.b.score)[0];
      if (worst) {
        setSelected({ template: worst.t.template, breakpoint: worst.b.breakpoint });
      }
    });
  }, [execute, loadStatus, projectPath]);

  // Widest first, which is the order breakpoints are usually written in, so
  // the column headings read the way the person who built the site is used to.
  const breakpoints = useMemo(() => {
    const all = new Set<number>();
    run?.templates.forEach((t) => {
      if (t.status === 'compared') t.breakpoints.forEach((b) => all.add(b.breakpoint));
    });
    return [...all].sort((a, b) => b - a);
  }, [run]);

  const comparison = useMemo(() => {
    if (!run || !selected) return null;
    const template = run.templates.find((t) => t.template === selected.template);
    if (template?.status !== 'compared') return null;
    return template.breakpoints.find((b) => b.breakpoint === selected.breakpoint) ?? null;
  }, [run, selected]);

  if (isLoading) {
    return (
      <div className="mig-panel mig-panel--centred">
        <Spinner size="lg" />
      </div>
    );
  }

  // Neither half depends on the other, and the status is the more important
  // one: a migration that has surveyed a site and planned ten templates but
  // not yet measured anything is a migration in good order. Gating the whole
  // panel on a comparison existing showed that as "nothing here", which is the
  // opposite of what the user needs to see when they come back to it.
  if (!status && !run) {
    return (
      <div className="mig-panel mig-panel--centred">
        <p className="mig-panel__empty">
          {error ? 'This project has no migration.' : 'Nothing here yet.'}
          <br />
          <span className="mig-panel__empty-detail">Start one from New Project → From a URL.</span>
        </p>
      </div>
    );
  }

  const sourceUrl = status?.sourceUrl ?? run?.reference ?? '';
  const overall = run ? runScore(run) : null;
  const band = overall === null ? null : fidelityBand(overall);

  return (
    <div className="mig-panel">
      <header className="mig-panel__header">
        <div className="mig-panel__score-block">
          {overall === null ? (
            <span className="mig-panel__no-score">Not measured yet</span>
          ) : (
            <>
              <span className={`mig-panel__score mig-panel__score--${band}`}>
                {overall.toFixed(1)}
                <span className="mig-panel__score-unit">%</span>
              </span>
              <span className="mig-panel__band">{band && FIDELITY_BAND_LABEL[band]}</span>
            </>
          )}
          {/* Worst, not mean. An average across breakpoints is exactly the
              statistic that hides a broken phone layout behind a good desktop
              one, which is the failure this panel exists to catch. It captions
              a number, so it is absent when there is none to caption. */}
          {overall !== null && <span className="mig-panel__score-note">worst breakpoint</span>}
        </div>

        <dl className="mig-panel__sources">
          <div>
            <dt>Original</dt>
            <dd>
              {/* Known from the status alone, so it is still shown before any
                  comparison has been run. */}
              <a href={sourceUrl} target="_blank" rel="noreferrer">
                {sourceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </a>
            </dd>
          </div>
          {run && (
            <div>
              <dt>Rebuild</dt>
              <dd>
                {run.rebuild.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                {run.rebuildOverlay && (
                  <span className="mig-panel__overlay-note"> + {run.rebuildOverlay}</span>
                )}
              </dd>
            </div>
          )}
        </dl>

        <div className="mig-panel__actions">
          {status && (
            <Button variant="primary" onClick={() => void resume()}>
              Resume
            </Button>
          )}
          {run && (
            <Button variant="secondary" onClick={() => void execute(projectPath)}>
              Compare again
            </Button>
          )}
        </div>
      </header>

      {status && <MigrationStatusView status={status} />}

      {run ? (
        <>
          {run.history.length > 1 && <FidelityHistory history={run.history} />}

          <FidelityMatrix
            templates={run.templates}
            breakpoints={breakpoints}
            selected={selected}
            onSelect={(template, breakpoint) => setSelected({ template, breakpoint })}
          />

          {comparison && selected ? (
            <ComparisonViewer comparison={comparison} templateLabel={selected.template} />
          ) : (
            <p className="mig-panel__hint">Pick a score to see what produced it.</p>
          )}
        </>
      ) : (
        // Stated rather than left blank: nothing has been measured, which is
        // an ordinary state early on and not a fault.
        <p className="mig-panel__hint">Nothing has been compared against the original yet.</p>
      )}
    </div>
  );
}

/**
 * Where the loop has been.
 *
 * One bar per pass, labelled with the fix that pass made. This is the part
 * that turns a score into a process: it shows that the number moved, and what
 * moved it, which is what tells you whether to keep going or stop.
 */
function FidelityHistory({ history }: { history: FidelityRun['history'] }) {
  const first = history[0];
  const last = history[history.length - 1];

  return (
    <section className="mig-history" aria-label="Comparison history">
      <div className="mig-history__summary">
        <span className="mig-history__from">{first.score.toFixed(1)}%</span>
        <span className="mig-history__arrow" aria-hidden="true">
          →
        </span>
        <span className="mig-history__to">{last.score.toFixed(1)}%</span>
        <span className="mig-history__passes">
          over {history.length} {history.length === 1 ? 'pass' : 'passes'}
        </span>
      </div>
      <ol className="mig-history__list">
        {history.map((entry) => {
          const band = fidelityBand(entry.score);
          return (
            <li key={entry.iteration} className="mig-history__item">
              <div className="mig-history__track">
                {/* Anchored at 80 rather than 0: every score worth reading sits
                    in the last fifth of the range, and a bar from zero makes
                    89% and 100% look like the same bar. */}
                <div
                  className={`mig-history__bar mig-history__bar--${band}`}
                  /* inline-style-ok: bar length is the measurement itself */
                  style={{ width: `${Math.max(0, (entry.score - 80) / 0.2)}%` }}
                />
              </div>
              <span className="mig-history__value">{entry.score.toFixed(2)}%</span>
              <span className="mig-history__note">{entry.note}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
