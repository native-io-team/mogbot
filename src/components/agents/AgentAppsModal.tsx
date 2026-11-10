/**
 * Apps your agents can use.
 *
 * **Ours first.** Every app this app signs in to itself (Linear, Notion,
 * Figma, Stripe, Vercel, Sentry: `agents/app_connect.rs`) connects with one
 * click: pick which agents may use it and how, then its own sign-in opens in
 * this Mac's browser and the row says "Connected as …". The token goes into
 * this Mac's Keychain; agents on Claude Code and Codex alike reach it through
 * the bridge's relay. The same sign-in, states and words as a login card's
 * Connect. It used to add the app to Claude Code and sign in by typing /mcp
 * in a raw `claude` terminal, which first showed Claude Code's folder-trust
 * prompt.
 *
 * Then what only comes through Claude: claude.ai's connectors (Gmail,
 * Calendar, Slack…), and the servers set up in Claude Code itself, listed as
 * such (Claude Code agents only).
 *
 * Opened from the agent editor, a chat and ⌘K → "Connect an app for agents…".
 *
 * @module components/agents/AgentAppsModal
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ErrorIcon } from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Spinner } from '../primitives/Spinner';
import { Checkbox } from '../primitives/Checkbox';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { OnboardingTerminal } from '../terminal/lazyTerminals';
import { SignInHelp } from './SignInHelp';
import { useAsyncState } from '../../hooks/useAsyncState';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { deleteConnection, flowLine, type Access, type Connection } from '../../lib/agentLogins';
import {
  ACCESS_CHOICES,
  APP_CONNECT_EVENT,
  appConnections,
  appManagedWhere,
  appStatusLabel,
  appTarget,
  appTitle,
  cancelAppConnect,
  connectApp,
  connectionAccount,
  defaultGrantees,
  grantNote,
  grantsLine,
  keptWhere,
  listAgentApps,
  openClaudeConnectors,
  ourAppFor,
  pickerAccess,
  removeAgentApp,
  reopenAppConnect,
  setConnectionGrants,
  type AgentApp,
  type AppConnectFlow,
  type ConnectableApp,
  type GrantChoice,
} from '../../lib/agentApps';

/** Who can be given an app. */
export interface AppsAgent {
  id: string;
  name: string;
  isMain: boolean;
}

interface AgentAppsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The team, for "Which agents can use it?". */
  agents?: readonly AppsAgent[];
  /** Opened for this agent: it's the one ticked to start with. */
  forAgentId?: string | null;
}

const errorText = (err: unknown) => formatCommandError(asCommandError(err));

export function AgentAppsModal({ isOpen, onClose, agents = [], forAgentId }: AgentAppsModalProps) {
  const ours = useAsyncState(appConnections);
  const claude = useAsyncState(listAgentApps);
  const [flows, setFlows] = useState<Record<string, AppConnectFlow>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  // The display name for the dialog's title, and the raw server name /mcp lists.
  const [signingIn, setSigningIn] = useState<{ title: string; name: string } | null>(null);
  const { execute: loadOurs } = ours;
  const { execute: loadClaude } = claude;

  useEffect(() => {
    if (!isOpen) return;
    void loadOurs();
    void loadClaude();
  }, [isOpen, loadOurs, loadClaude]);

  // The overview carries any sign-in already under way (opened in another
  // window, or before this one closed); events carry it from then on.
  useEffect(() => {
    if (!ours.data) return;
    setFlows((prev) => {
      const next = { ...prev };
      for (const f of ours.data?.flows ?? []) next[f.service] ??= f;
      return next;
    });
  }, [ours.data]);

  useEffect(() => {
    if (!isOpen) return;
    const off = listen<AppConnectFlow>(APP_CONNECT_EVENT, (e) => {
      setFlows((prev) => ({ ...prev, [e.payload.service]: e.payload }));
      if (e.payload.connected) void loadOurs();
    });
    return () => {
      // Gone already (the window closing) is fine.
      void off.then((un) => un()).catch(() => undefined);
    };
  }, [isOpen, loadOurs]);

  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const connections = ours.data?.connections ?? [];
  const catalogue = ours.data?.apps ?? [];
  const connectedServices = new Set(connections.map((c) => c.service));
  const toConnect = catalogue.filter(
    (a) => !connectedServices.has(a.service) || flows[a.service]?.flow
  );
  const claudeOwn = (claude.data?.connected ?? []).filter((a) => a.source !== 'claudeAi');
  const claudeAi = (claude.data?.connected ?? []).filter((a) => a.source === 'claudeAi');

  return (
    <>
      <ModalFrame
        isOpen={isOpen && !signingIn}
        onClose={onClose}
        title="Apps your agents can use"
        className="agent-apps"
      >
        <div className="agent-apps__body">
          <p className="agent-apps__lead">
            Connect an app once and choose which agents can use it. You sign in in your browser; the
            sign-in stays in this Mac’s Keychain.
          </p>

          {ours.error && (
            <p className="agent-apps__error" role="alert">
              <ErrorIcon size={12} className="inline-error-icon" />
              {ours.error.message}{' '}
              <TextButton tabIndex={0} onClick={() => void loadOurs()}>
                Try again
              </TextButton>
            </p>
          )}
          {ours.isLoading && !ours.data && (
            <p className="agent-apps__quiet">
              <Spinner size="sm" /> Loading…
            </p>
          )}

          {connections.length > 0 && (
            <section className="agent-apps__section" aria-labelledby="agent-apps-connected">
              <h3 id="agent-apps-connected" className="agent-apps__heading">
                Connected
              </h3>
              <ul className="agent-apps__list">
                {connections.map((c) => (
                  <ConnectionRow
                    key={c.id}
                    connection={c}
                    app={catalogue.find((a) => a.service === c.service)}
                    agents={agents}
                    names={names}
                    flow={flows[c.service]}
                    onChanged={() => void loadOurs()}
                    onError={setActionError}
                  />
                ))}
              </ul>
            </section>
          )}

          {ours.data && toConnect.length > 0 && (
            <section className="agent-apps__section" aria-labelledby="agent-apps-add">
              <h3 id="agent-apps-add" className="agent-apps__heading">
                Connect an app
              </h3>
              <ul className="agent-apps__list">
                {toConnect.map((app) => (
                  <ConnectRow
                    key={app.service}
                    app={app}
                    agents={agents}
                    initial={defaultGrantees(agents, forAgentId)}
                    flow={flows[app.service]}
                  />
                ))}
              </ul>
            </section>
          )}

          <section className="agent-apps__section" aria-labelledby="agent-apps-claude-ai">
            <h3 id="agent-apps-claude-ai" className="agent-apps__heading">
              Through claude.ai
            </h3>
            {/* Mail, calendar and chat only come through claude.ai's connectors. */}
            <ul className="agent-apps__list">
              <li className="agent-apps__row">
                <div className="agent-apps__text">
                  <span className="agent-apps__name">
                    {claudeAi.length > 0
                      ? claudeAi.map((a) => appTitle(a)).join(', ')
                      : 'Gmail, Google Calendar, Slack and more'}
                  </span>
                  <span className="agent-apps__meta agent-apps__meta--wrap">
                    {claudeAi.length > 0
                      ? 'Connected on claude.ai. They reach agents on Claude Code signed in with that account.'
                      : 'Connect these on claude.ai, under Customize → Connectors. They reach agents on Claude Code signed in with that account.'}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() =>
                    void openClaudeConnectors().catch((err: unknown) =>
                      setActionError(errorText(err))
                    )
                  }
                >
                  Open claude.ai
                </Button>
              </li>
            </ul>
          </section>

          {(claudeOwn.length > 0 || claude.isLoading) && (
            <section className="agent-apps__section" aria-labelledby="agent-apps-claude-code">
              <h3 id="agent-apps-claude-code" className="agent-apps__heading">
                Set up in Claude Code
                {claude.isLoading && <Spinner size="sm" />}
              </h3>
              {claudeOwn.length > 0 && (
                <>
                  <p className="agent-apps__note">
                    Claude Code’s own servers. Only agents on Claude Code use these.
                  </p>
                  <ul className="agent-apps__list">
                    {claudeOwn.map((app) => (
                      <ClaudeCodeRow
                        key={app.name}
                        app={app}
                        ours={ourAppFor(app, catalogue)}
                        onSignIn={() => setSigningIn({ title: appTitle(app), name: app.name })}
                        onRemoved={() => void loadClaude()}
                        onError={setActionError}
                      />
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {actionError && (
            <p className="agent-apps__error" role="alert">
              <ErrorIcon size={12} className="inline-error-icon" />
              {actionError}
            </p>
          )}

          <div className="agent-apps__actions">
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </ModalFrame>

      {signingIn && (
        <ModalFrame
          isOpen
          onClose={() => {
            setSigningIn(null);
            void loadClaude();
          }}
          title={`Sign in to ${signingIn.title} in Claude Code`}
          className="agents-panel-terminal-modal"
        >
          <p className="agent-apps__terminal-hint">
            This is Claude Code itself. If it asks whether to trust this folder, choose Yes (it’s
            the agents’ folder). Then type /mcp, choose {signingIn.name}, then Authenticate. Close
            this once it says connected.
          </p>
          <div className="agents-panel-terminal-body">
            <OnboardingTerminal
              command="claude"
              args={[]}
              onExit={() => {
                setSigningIn(null);
                void loadClaude();
              }}
            />
          </div>
        </ModalFrame>
      )}
    </>
  );
}

/* --------------------------------------------------------------- grants */

/** "Which agents can use it?": ticks, and read or read-and-change for all of them. */
function GrantPicker({
  agents,
  picked,
  access,
  onPick,
  onAccess,
}: {
  agents: readonly AppsAgent[];
  picked: readonly string[];
  access: Access;
  onPick: (ids: string[]) => void;
  onAccess: (access: Access) => void;
}) {
  return (
    <div className="agent-apps__grants">
      <span className="agent-apps__grants-label">Which agents can use it?</span>
      <div className="agent-apps__agents">
        {agents.map((a) => (
          <label key={a.id} className="agent-apps__agent">
            <Checkbox
              checked={picked.includes(a.id)}
              label={a.name}
              onChange={(on) => onPick(on ? [...picked, a.id] : picked.filter((id) => id !== a.id))}
            />
            <span>{a.name}</span>
          </label>
        ))}
      </div>
      <SegmentedControl<Access>
        aria-label="What they can do"
        value={access}
        onValueChange={onAccess}
        options={ACCESS_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
      />
      <span className="agent-apps__meta agent-apps__meta--wrap">
        {grantNote(access, picked.length === 0)}
      </span>
    </div>
  );
}

const grantsOf = (ids: readonly string[], access: Access): GrantChoice[] =>
  ids.map((agentId) => ({ agentId, access }));

/* ----------------------------------------------------------------- rows */

/** A connect from this dialog, while it signs in: the card's words, Open again · Copy link, Stop. */
function FlowLine({
  service,
  title,
  live,
}: {
  service: string;
  title: string;
  live: AppConnectFlow;
}) {
  const flow = live.flow;
  if (!flow) return null;
  if (flow.state === 'starting' || flow.state === 'waiting') {
    return (
      <div className="agent-apps__flow" role="status">
        <span className="agent-apps__quiet">
          <Spinner size="sm" /> {flowLine(flow, title)}{' '}
          <TextButton tabIndex={0} onClick={() => void cancelAppConnect(service)}>
            Stop
          </TextButton>
        </span>
        <SignInHelp flow={flow} reopen={() => reopenAppConnect(service)} />
      </div>
    );
  }
  return (
    <p
      className={flow.state === 'failed' ? 'agent-apps__error' : 'agent-apps__quiet'}
      role={flow.state === 'failed' ? 'alert' : undefined}
    >
      {flow.state === 'failed' && <ErrorIcon size={12} className="inline-error-icon" />}
      {flow.message ?? (flow.state === 'failed' ? 'That didn’t work. Try again.' : 'Stopped.')}
    </p>
  );
}

const signingIn = (live?: AppConnectFlow) =>
  live?.flow?.state === 'starting' || live?.flow?.state === 'waiting';

function ConnectRow({
  app,
  agents,
  initial,
  flow,
}: {
  app: ConnectableApp;
  agents: readonly AppsAgent[];
  initial: string[];
  flow?: AppConnectFlow;
}) {
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<string[]>(initial);
  const [access, setAccess] = useState<Access>('read');
  const [error, setError] = useState<string | null>(null);
  const busy = signingIn(flow);
  const start = useCallback(() => {
    setError(null);
    connectApp(app.service, grantsOf(picked, access))
      .then(() => setChoosing(false))
      .catch((err: unknown) => setError(errorText(err)));
  }, [app.service, picked, access]);

  return (
    <li className="agent-apps__row agent-apps__row--stack" data-service={app.service}>
      <div className="agent-apps__line">
        <div className="agent-apps__text" title={app.host}>
          <span className="agent-apps__name">{app.title}</span>
          <span className="agent-apps__meta">{app.read}</span>
        </div>
        {!choosing && !busy && (
          <Button
            variant="secondary"
            size="compact"
            onClick={() => setChoosing(true)}
            aria-label={`Connect ${app.title}`}
          >
            {flow?.flow?.state === 'failed' ? 'Try again' : 'Connect'}
          </Button>
        )}
      </div>
      {choosing && !busy && (
        <>
          <GrantPicker
            agents={agents}
            picked={picked}
            access={access}
            onPick={setPicked}
            onAccess={setAccess}
          />
          <div className="agent-apps__row-actions">
            <TextButton tabIndex={0} onClick={() => setChoosing(false)}>
              Cancel
            </TextButton>
            <Button size="compact" onClick={start}>
              Sign in to {app.title}
            </Button>
          </div>
        </>
      )}
      {flow && !choosing && <FlowLine service={app.service} title={app.title} live={flow} />}
      {error && (
        <p className="agent-apps__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
    </li>
  );
}

function ConnectionRow({
  connection: c,
  app,
  agents,
  names,
  flow,
  onChanged,
  onError,
}: {
  connection: Connection;
  /** Ours to sign in to again; absent for claude.ai and GitHub's CLI. */
  app?: ConnectableApp;
  agents: readonly AppsAgent[];
  names: ReadonlyMap<string, string>;
  flow?: AppConnectFlow;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [picked, setPicked] = useState<string[]>(() => c.grants.map((g) => g.agentId));
  const [access, setAccess] = useState<Access>(() => pickerAccess(c.grants));
  const account = connectionAccount(c);
  const justNow = flow?.connected?.connectionId === c.id ? flow.connected.line : null;
  const kept = keptWhere(c.kind.type);

  const save = () => {
    onError(null);
    setConnectionGrants(c.id, grantsOf(picked, access))
      .then(() => {
        setEditing(false);
        onChanged();
      })
      .catch((err: unknown) => onError(errorText(err)));
  };
  const remove = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    onError(null);
    deleteConnection(c.id)
      .then(onChanged)
      .catch((err: unknown) => onError(errorText(err)))
      .finally(() => setConfirming(false));
  };
  const signInAgain = () => {
    onError(null);
    void connectApp(
      c.service,
      c.grants.map((g) => ({ agentId: g.agentId, access: g.access })),
      c.id
    ).catch((err: unknown) => onError(errorText(err)));
  };

  return (
    <li className="agent-apps__row agent-apps__row--stack" data-connection={c.id}>
      <div className="agent-apps__line">
        <div className="agent-apps__text">
          <span className="agent-apps__name">
            {c.title}
            {account && <span className="agent-apps__account"> · {account}</span>}
          </span>
          <span className="agent-apps__meta agent-apps__meta--wrap">
            {kept} · {grantsLine(c, names)}
          </span>
        </div>
        {c.needsSignIn ? (
          <span className="agent-apps__status" data-status="needs_auth">
            Needs sign-in
          </span>
        ) : (
          justNow && (
            <span className="agent-apps__status" data-status="connected">
              {justNow}
            </span>
          )
        )}
      </div>
      {editing ? (
        <>
          <GrantPicker
            agents={agents}
            picked={picked}
            access={access}
            onPick={setPicked}
            onAccess={setAccess}
          />
          <div className="agent-apps__row-actions">
            <TextButton tabIndex={0} onClick={() => setEditing(false)}>
              Cancel
            </TextButton>
            <Button size="compact" onClick={save}>
              Save
            </Button>
          </div>
        </>
      ) : (
        !signingIn(flow) && (
          <div className="agent-apps__row-actions">
            {c.needsSignIn && app && (
              <TextButton tabIndex={0} onClick={signInAgain}>
                Sign in again
              </TextButton>
            )}
            <TextButton tabIndex={0} onClick={() => setEditing(true)}>
              Who can use it
            </TextButton>
            <TextButton
              tabIndex={0}
              className="agent-apps__remove"
              data-confirming={confirming || undefined}
              onClick={remove}
              aria-label={confirming ? `Confirm removing ${c.title}` : `Remove ${c.title}`}
            >
              {confirming ? 'Remove?' : 'Remove'}
            </TextButton>
          </div>
        )
      )}
      {flow && app && <FlowLine service={c.service} title={c.title} live={flow} />}
    </li>
  );
}

function ClaudeCodeRow({
  app,
  ours,
  onSignIn,
  onRemoved,
  onError,
}: {
  app: AgentApp;
  /** The same app, which can be connected above for every engine instead. */
  ours?: ConnectableApp;
  onSignIn: () => void;
  onRemoved: () => void;
  onError: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const status = appStatusLabel(app.status);
  const managed = appManagedWhere(app.source);
  const remove = () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    onError(null);
    removeAgentApp(app.name)
      .then(onRemoved)
      .catch((err: unknown) => onError(errorText(err)))
      .finally(() => setConfirming(false));
  };
  return (
    <li className="agent-apps__row">
      {/* Where it connects (a host or a command) is a detail for the curious:
          a tooltip, not a line every row has to carry. */}
      <div className="agent-apps__text" title={appTarget(app.target)}>
        <span className="agent-apps__name">{appTitle(app)}</span>
        {ours ? (
          <span className="agent-apps__meta">
            Connect it above to use it on Claude Code and Codex alike
          </span>
        ) : (
          managed && <span className="agent-apps__meta">{managed}</span>
        )}
      </div>
      {status && (
        <span className="agent-apps__status" data-status={app.status}>
          {status}
        </span>
      )}
      {/* One we connect ourselves is connected above, never through /mcp. */}
      {app.status === 'needs_auth' && !ours && (
        <TextButton tabIndex={0} onClick={onSignIn}>
          Sign in…
        </TextButton>
      )}
      {app.source === 'user' && (
        <TextButton
          tabIndex={0}
          className="agent-apps__remove"
          data-confirming={confirming || undefined}
          onClick={remove}
          aria-label={confirming ? `Confirm removing ${app.name}` : `Remove ${app.name}`}
        >
          {confirming ? 'Remove?' : 'Remove'}
        </TextButton>
      )}
    </li>
  );
}
