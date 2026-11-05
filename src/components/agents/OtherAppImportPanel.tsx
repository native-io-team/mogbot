/**
 * Import from the other app on this Mac (`OTHER_APP_NAME`): its agents are
 * already on disk, so there is nothing to ask anyone for. This lists what
 * would come across, agent by agent, and copies it in one step
 * (`agents/other_app.rs`). The other app's folder is only ever read.
 *
 * What stays behind is said before the import, not after: saved secrets
 * (they're in the other app's Keychain; each agent asks again here) and that
 * routines arrive paused so nothing runs in both apps.
 *
 * @module components/agents/OtherAppImportPanel
 */

import { useState } from 'react';
import { ChevronRightIcon, InfoIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { useAgentsList } from '../../lib/agentsStore';
import {
  importFromOtherApp,
  type OtherAppAgent,
  type OtherAppPreview,
  type OtherAppSummary,
} from '../../lib/agents';
import { AgentAvatar } from './AgentAvatar';
import { ImportProblems, listOf, plural } from './ImportParts';
import type { ImportResult } from './ImportPastePanel';

/** Which of its agents an import would bring (new ones, and the Chief's merge). */
export const arriving = (preview: OtherAppPreview | null) =>
  preview?.agents.filter((a) => a.plan === 'new' || a.plan === 'merge') ?? [];

const CHIPS: Record<OtherAppAgent['plan'], [string, string]> = {
  merge: ['main', 'Merges into Chief of Staff'],
  new: ['new', 'New'],
  imported: ['update', 'Already here'],
  skip: ['skip', 'Stays behind'],
};

function counts(agent: OtherAppAgent) {
  return [
    agent.messages ? plural(agent.messages, 'message') : 'No conversation yet',
    agent.memory.length
      ? `${agent.memory.length.toLocaleString()} ${agent.memory.length === 1 ? 'memory' : 'memories'}`
      : '',
    agent.attachments ? plural(agent.attachments, 'file') : '',
    agent.routines.length ? plural(agent.routines.length, 'routine') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function Detail({ agent }: { agent: OtherAppAgent }) {
  return (
    <div className="agents-import-agent__detail">
      {agent.reason && <p className="agents-import-agent__none">{agent.reason}</p>}
      <section>
        <h4>Instructions</h4>
        {agent.instructions ? (
          <p className="agents-import-agent__instructions">{agent.instructions}</p>
        ) : (
          <p className="agents-import-agent__none">None written.</p>
        )}
      </section>
      <section>
        <h4>Memory</h4>
        {agent.memory.length ? (
          <ul className="agents-import-agent__memory">
            {agent.memory.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : (
          <p className="agents-import-agent__none">Nothing remembered yet.</p>
        )}
      </section>
      {agent.routines.length > 0 && (
        <section>
          <h4>Routines, arriving paused</h4>
          <ul className="agents-import-agent__routines">
            {agent.routines.map((r, i) => (
              <li key={i}>
                <span>
                  <strong>{r.schedule}</strong> {r.what}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(agent.project || agent.projectMissing) && (
        <section>
          <h4>Project</h4>
          <p className={agent.project ? undefined : 'agents-import-agent__none'}>
            {agent.project ?? 'Its project folder isn’t on this Mac any more; it works on its own.'}
          </p>
        </section>
      )}
    </div>
  );
}

function Row({ agent, mainName }: { agent: OtherAppAgent; mainName: string }) {
  const [open, setOpen] = useState(false);
  const [kind, label] = CHIPS[agent.plan];
  const away = agent.plan === 'imported' || agent.plan === 'skip';
  return (
    <li className="agents-import-agent" data-open={open || undefined} data-away={away || undefined}>
      {/* A large disclosure surface, not an action: a raw button by design. */}
      <button
        type="button"
        className="agents-import-agent__row"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <AgentAvatar name={agent.isMain ? mainName : agent.name} color={agent.color} />
        <span className="agents-import-agent__text">
          <span className="agents-import-agent__name">
            <span className="agents-import-agent__name-text">{agent.name}</span>
            <span className="agents-import-chip" data-kind={kind}>
              {label}
            </span>
          </span>
          {agent.role && <span className="agents-import-agent__role">{agent.role}</span>}
          <span className="agents-import-agent__counts">
            {agent.plan === 'skip' && agent.reason ? (
              <span className="agents-import-agent__warn">{agent.reason}</span>
            ) : (
              <>
                {counts(agent)}
                {agent.secrets.length > 0 && (
                  <span className="agents-import-agent__warn">
                    {' · '}
                    {plural(agent.secrets.length, 'secret')} to re-enter
                  </span>
                )}
              </>
            )}
          </span>
        </span>
        <ChevronRightIcon size={12} className="agents-import-agent__chevron" />
      </button>
      <div className="agents-import-agent__reveal">
        <div>{open && <Detail agent={agent} />}</div>
      </div>
    </li>
  );
}

/** What the done state adds: what was left behind, and what to do about it. */
function DoneExtra({ summary }: { summary: OtherAppSummary }) {
  const items = [
    ...summary.secretsLeft.map((s) => (
      <>
        <strong>{s.agent}</strong> will ask you again for {listOf(s.secrets)}: saved secrets stay in{' '}
        {summary.appName}.
      </>
    )),
    ...(summary.routinesPaused
      ? [
          <>
            {plural(summary.routinesPaused, 'routine')} arrived paused, so nothing runs in both
            apps. Turn them on from each agent’s schedule when you’re ready.
          </>,
        ]
      : []),
    ...(summary.already.length
      ? [<>Already here from an earlier import, so left as is: {listOf(summary.already)}.</>]
      : []),
  ];
  return items.length ? <ImportProblems title="Before they get going" items={items} /> : null;
}

interface OtherAppImportPanelProps {
  preview: OtherAppPreview;
  onCancel: () => void;
  onDone: (result: ImportResult) => void;
}

export function OtherAppImportPanel({ preview, onCancel, onDone }: OtherAppImportPanelProps) {
  const mainName = useAgentsList().find((a) => a.isMain)?.name ?? 'Chief of Staff';
  const coming = arriving(preview);
  const secrets = preview.agents.filter(
    (a) => a.secrets.length > 0 && (a.plan === 'new' || a.plan === 'merge')
  );
  const routines = coming.reduce((n, a) => n + a.routines.length, 0);
  const importer = useAsyncState(async () => {
    try {
      const summary = await importFromOtherApp();
      onDone({
        summary,
        agents: coming.map((a) => ({ name: a.name, isMain: a.isMain, color: a.color })),
        extra: <DoneExtra summary={summary} />,
      });
      return summary;
    } catch (e) {
      throw new Error(formatCommandError(asCommandError(e)));
    }
  });

  return (
    <>
      <div className="agents-import__body">
        <p className="agents-import__lede">
          Your {preview.appName} team is on this Mac. Bring it across with its instructions, memory,
          conversations and files. {preview.appName} keeps its own copy, untouched.
        </p>
        <div className="agents-import-preview" aria-live="polite">
          <p className="agents-import-preview__found">
            <strong>{plural(preview.agents.length, 'agent')}</strong> in {preview.appName}
            {coming.length < preview.agents.length &&
              ` · ${coming.length ? `${coming.length} to bring over` : 'all already here'}`}
          </p>
          <ul className="agents-import-preview__list">
            {preview.agents.map((a) => (
              <Row key={a.sourceId || a.name} agent={a} mainName={mainName} />
            ))}
          </ul>
        </div>
        {coming.length > 0 && (secrets.length > 0 || routines > 0) && (
          <div className="agents-import-behind">
            <InfoIcon size={14} className="agents-import-behind__icon" />
            <ul>
              {secrets.length > 0 && (
                <li>
                  Saved secrets stay in {preview.appName}: credentials aren’t copied between apps.{' '}
                  {listOf(secrets.map((a) => (a.isMain ? mainName : a.name)))} will ask you to enter{' '}
                  {secrets.length === 1 && secrets[0].secrets.length === 1 ? 'it' : 'them'} again
                  here.
                </li>
              )}
              {routines > 0 && (
                <li>
                  {plural(routines, 'routine')} will arrive paused, so nothing runs in both apps.
                </li>
              )}
            </ul>
          </div>
        )}
        {importer.error && (
          <p className="agents-import__error" role="alert">
            {importer.error.message}
          </p>
        )}
      </div>
      <footer className="agents-import__footer">
        <p className="agents-import__note">
          Nothing in {preview.appName} changes. Importing again skips agents already here.
        </p>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!coming.length || importer.isLoading}
          onClick={() => void importer.execute()}
        >
          {coming.length ? `Import ${plural(coming.length, 'agent')}` : 'Nothing to import'}
        </Button>
      </footer>
    </>
  );
}
