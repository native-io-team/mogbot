/**
 * Import from the other app on this Mac (its name is the preview's
 * `appName`): its agents are already on disk, so there is nothing to ask
 * anyone for. This lists what would come across, agent by agent, and copies
 * it in one step (`agents/other_app.rs`). The other app's folder is only
 * ever read.
 *
 * What it says before the import, not after:
 * - exactly what context each agent gets: its chat history, picking up from
 *   the most recent messages; the Chief gets a recap of the other Chief's;
 * - saved secrets stay behind (they're in the other app's Keychain);
 * - "Always allow" rules are listed and left behind unless the user keeps them;
 * - routines arrive paused, and their twins in the other app keep running;
 * - an agent bound to a project shares that folder with its twin;
 * - how much a copy to another volume writes, and whether it fits.
 *
 * @module components/agents/OtherAppImportPanel
 */

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Checkbox';
import { Progress } from '../primitives/Progress';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { loadMessages, useAgentsList } from '../../lib/agentsStore';
import {
  AGENT_EVENTS,
  importFromOtherApp,
  type OtherAppAgent,
  type OtherAppPreview,
  type OtherAppProgress,
  type OtherAppSummary,
} from '../../lib/agents';
import {
  ImportAgentRow,
  ImportNotes,
  ImportSection,
  listOf,
  plural,
  type ImportChipKind,
} from './ImportParts';
import type { ImportResult } from './ImportPastePanel';

/** Which of its agents an import would bring (new ones, and the Chief's merge). */
export const arriving = (preview: OtherAppPreview | null) =>
  preview?.agents.filter((a) => a.plan === 'new' || a.plan === 'merge') ?? [];

/** "1.2 GB", "340 MB". */
export function formatBytes(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return value >= 10 || unit === 0
    ? `${Math.max(1, Math.round(value))} ${units[unit]}`
    : `${value.toFixed(1)} ${units[unit]}`;
}

/** The import button: what it does, counting the merge apart from new agents. */
export function importLabel(coming: OtherAppAgent[], mainName: string): string {
  const fresh = coming.filter((a) => a.plan === 'new').length;
  const merge = coming.some((a) => a.plan === 'merge');
  if (fresh && merge) return `Import ${plural(fresh, 'agent')} and merge`;
  if (fresh) return `Import ${plural(fresh, 'agent')}`;
  if (merge) return `Merge into ${mainName}`;
  return 'Nothing to import';
}

function chip(
  plan: OtherAppAgent['plan'],
  mainName: string
): { kind: ImportChipKind; label: string } {
  switch (plan) {
    case 'merge':
      return { kind: 'main', label: `Merges into ${mainName}` };
    case 'new':
      return { kind: 'new', label: 'New' };
    case 'imported':
      return { kind: 'update', label: 'Already here' };
    default:
      return { kind: 'skip', label: 'Stays behind' };
  }
}

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

function Detail({
  agent,
  appName,
  mainName,
}: {
  agent: OtherAppAgent;
  appName: string;
  mainName: string;
}) {
  const coming = agent.plan === 'new' || agent.plan === 'merge';
  return (
    <>
      {agent.reason && <p className="agents-import-agent__none">{agent.reason}</p>}
      {coming && agent.messages > 0 && (
        <ImportSection title="Conversation">
          <p>
            {agent.isMain
              ? `Shown in ${mainName}’s chat under “From ${appName}”. ${mainName} keeps its own conversation, so it gets a recap of the most recent part to read, not the whole thread.`
              : `Its chat history comes with it. It starts a new conversation here and picks up from its most recent messages.`}
          </p>
        </ImportSection>
      )}
      <ImportSection title="Instructions">
        {agent.instructions ? (
          <p className="agents-import-agent__instructions">{agent.instructions}</p>
        ) : (
          <p className="agents-import-agent__none">None written.</p>
        )}
      </ImportSection>
      <ImportSection title="Memory">
        {agent.memory.length ? (
          <ul className="agents-import-agent__memory">
            {agent.memory.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : (
          <p className="agents-import-agent__none">Nothing remembered yet.</p>
        )}
      </ImportSection>
      {agent.routines.length > 0 && (
        <ImportSection title="Routines · arrive paused">
          <ul className="agents-import-agent__routines">
            {agent.routines.map((r, i) => (
              <li key={i}>
                <span>
                  <strong>{r.schedule}</strong> {r.what}
                </span>
              </li>
            ))}
          </ul>
        </ImportSection>
      )}
      {agent.rules.length > 0 && (
        <ImportSection title="Always allow rules">
          <p>{listOf(agent.rules)}</p>
        </ImportSection>
      )}
      {(agent.project || agent.projectMissing) && (
        <ImportSection title="Project">
          {agent.project ? (
            <>
              <p>{agent.project}</p>
              <p className="agents-import-agent__none">
                Its {appName} copy works in this same folder.
              </p>
            </>
          ) : (
            <p className="agents-import-agent__none">
              Its project folder isn’t on this Mac any more; it works on its own.
            </p>
          )}
        </ImportSection>
      )}
    </>
  );
}

function Row({
  agent,
  appName,
  mainName,
}: {
  agent: OtherAppAgent;
  appName: string;
  mainName: string;
}) {
  const away = agent.plan === 'imported' || agent.plan === 'skip';
  return (
    <ImportAgentRow
      name={agent.name}
      avatarName={agent.isMain ? mainName : agent.name}
      color={agent.color}
      chip={chip(agent.plan, mainName)}
      role={agent.role || undefined}
      away={away}
      counts={
        agent.plan === 'skip' && agent.reason ? (
          <span className="agents-import-agent__warn">{agent.reason}</span>
        ) : (
          <>
            {counts(agent)}
            {agent.secrets.length > 0 && (
              <span className="agents-import-agent__warn">
                {' · '}
                {plural(agent.secrets.length, 'login')} to re-enter
              </span>
            )}
          </>
        )
      }
      detail={() => <Detail agent={agent} appName={appName} mainName={mainName} />}
    />
  );
}

const rulesLine = (notes: { agent: string; rules: string[] }[]) =>
  listOf(notes.map((n) => `${n.agent} (${listOf(n.rules)})`));

/** What the done state adds: informational, so neutral, never a warning. */
export function DoneExtra({ summary }: { summary: OtherAppSummary }) {
  const items = [
    ...summary.secretsLeft.map((s) => (
      <>
        <strong>{s.agent}</strong> will ask you again for {listOf(s.secrets)}: saved logins stay in{' '}
        {summary.appName}.
      </>
    )),
    ...(summary.routinesPaused
      ? [
          <>
            {plural(summary.routinesPaused, 'routine')} arrived paused, and their copies in{' '}
            {summary.appName} keep running. Turn each on here once it’s off there.
          </>,
        ]
      : []),
    ...(summary.rulesLeft.length
      ? [
          <>
            “Always allow” rules stayed behind for {rulesLine(summary.rulesLeft)}: those ask again
            the first time.
          </>,
        ]
      : []),
    ...(summary.rulesKept.length
      ? [<>“Always allow” rules came across for {rulesLine(summary.rulesKept)}.</>]
      : []),
    ...(summary.already.length
      ? [<>Already here from an earlier import, so left as is: {listOf(summary.already)}.</>]
      : []),
  ];
  return <ImportNotes title="Before they get going" items={items} />;
}

interface OtherAppImportPanelProps {
  preview: OtherAppPreview;
  onCancel: () => void;
  onDone: (result: ImportResult) => void;
}

export function OtherAppImportPanel({ preview, onCancel, onDone }: OtherAppImportPanelProps) {
  const team = useAgentsList();
  const main = team.find((a) => a.isMain);
  const mainName = main?.name ?? 'Chief of Staff';
  const { appName } = preview;
  const coming = arriving(preview);
  const fresh = coming.filter((a) => a.plan === 'new');
  const merging = coming.some((a) => a.plan === 'merge');
  const secrets = coming.filter((a) => a.secrets.length > 0);
  const routines = coming.reduce((n, a) => n + a.routines.length, 0);
  const withRules = coming.filter((a) => a.rules.length > 0);
  const shared = coming.filter((a) => a.project);
  const [keepRules, setKeepRules] = useState(false);
  const [progress, setProgress] = useState<OtherAppProgress | null>(null);

  const importer = useAsyncState(async () => {
    try {
      const summary = await importFromOtherApp({ keepRules });
      // The Chief's chat gained a block of history before what's loaded.
      if (main && merging) void loadMessages(main.id);
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

  // A copy to another volume is a real copy: show how far it's got.
  useEffect(() => {
    if (!importer.isLoading) return;
    let live = true;
    const unlisten = listen<OtherAppProgress>(AGENT_EVENTS.importProgress, (e) => {
      if (live) setProgress(e.payload);
    });
    return () => {
      live = false;
      void unlisten.then((u) => u());
      setProgress(null);
    };
  }, [importer.isLoading]);

  const plan = [
    fresh.length ? `${fresh.length} new` : '',
    merging ? `1 merges into ${mainName}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const notes = [
    ...(secrets.length
      ? [
          <>
            Saved logins stay in {appName}: credentials aren’t copied between apps.{' '}
            {listOf(secrets.map((a) => (a.isMain ? mainName : a.name)))} will ask you to enter{' '}
            {secrets.length === 1 && secrets[0].secrets.length === 1 ? 'it' : 'them'} again here.
          </>,
        ]
      : []),
    ...(routines
      ? [
          <>
            {plural(routines, 'routine')} will arrive paused. Their copies in {appName} keep
            running, so turn each on here once it’s off there.
          </>,
        ]
      : []),
    ...(shared.length
      ? [
          <>
            {listOf(shared.map((a) => a.name))} {shared.length === 1 ? 'works' : 'work'} in the same
            project {shared.length === 1 ? 'folder' : 'folders'} as {appName}’s copy: use one app’s
            at a time so they don’t edit it at once.
          </>,
        ]
      : []),
    ...(!preview.sameVolume && preview.totalBytes > 0
      ? [
          <>
            {appName}’s folder is on another drive, so this copies {formatBytes(preview.totalBytes)}
            {preview.freeBytes !== undefined && ` (${formatBytes(preview.freeBytes)} free here)`}.
          </>,
        ]
      : []),
  ];

  return (
    <>
      <div className="agents-import__body">
        <p className="agents-import__lede">
          Your {appName} team is on this Mac. Each agent brings its instructions, memory, files and
          chat history, and picks up from its latest messages
          {merging ? ` (${mainName} from a recap of the other Chief’s)` : ''}. {appName} keeps its
          own copy, untouched.
        </p>
        <div className="agents-import-preview" aria-live="polite">
          <p className="agents-import-preview__found">
            <strong>{plural(preview.agents.length, 'agent')}</strong> in {appName}
            {plan ? ` · ${plan}` : ' · all already here'}
          </p>
          <ul className="agents-import-preview__list">
            {preview.agents.map((a) => (
              <Row key={a.sourceId || a.name} agent={a} appName={appName} mainName={mainName} />
            ))}
          </ul>
        </div>
        {coming.length > 0 && <ImportNotes items={notes} />}
        {withRules.length > 0 && (
          // The box draws itself; the label is the click target.
          <label className="agents-import-keep">
            <Checkbox
              checked={keepRules}
              onChange={setKeepRules}
              label="Keep their “Always allow” rules"
            />
            <span>
              <span className="agents-import-keep__title">
                Keep their “Always allow” rules (
                {withRules.reduce((n, a) => n + a.rules.length, 0).toLocaleString()})
              </span>
              <span className="agents-import-keep__hint">
                Left off, each asks you again the first time. Kept, they run without asking, as they
                did in {appName}.
              </span>
            </span>
          </label>
        )}
        {!preview.enoughSpace && (
          <p className="agents-import__error" role="alert">
            There isn’t room for this copy: it needs {formatBytes(preview.totalBytes)}
            {preview.freeBytes !== undefined && ` and ${formatBytes(preview.freeBytes)} is free`}.
            Free up some space, then open this again.
          </p>
        )}
        {importer.isLoading && progress && progress.totalBytes > 0 && (
          <div className="agents-import-progress" aria-live="polite">
            <Progress value={progress.doneBytes} max={progress.totalBytes} />
            <span>
              Copying {progress.agent} · {formatBytes(progress.doneBytes)} of{' '}
              {formatBytes(progress.totalBytes)}
            </span>
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
          Nothing in {appName} changes. Importing again skips agents already here.
        </p>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!coming.length || !preview.enoughSpace || importer.isLoading}
          onClick={() => void importer.execute()}
        >
          {importLabel(coming, mainName)}
        </Button>
      </footer>
    </>
  );
}
