/**
 * Settings → Agents: everything about running agents, in one calm place.
 *
 * - **On this Mac**: the menu-bar icon and quick message
 *   (`AgentsDesktopSettings`), and what keeps agents going (keep awake, keep
 *   running when closed, open at login — `useStayOn`, read back from the
 *   thing itself).
 * - **Engines and models**: which engine a new agent starts on, as
 *   `defaultEngine` decides it from the engines' real state, and what
 *   routines run on. Both are per agent; this says the rule and where to
 *   change it, and shows nothing it hasn't read.
 * - **Accounts**: each engine's accounts, in the order turns try them when
 *   one runs out of usage (`AgentAccounts`, `agents/wallet.rs`).
 * - **Notifications**: what notifies, and where to mute one agent.
 * - **Phone and other assistants**: the way into each.
 *
 * Every description is one line.
 *
 * @module components/agents/AgentsSettings
 */

import type { ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { AgentsDesktopSettings } from './AgentsDesktopSettings';
import { AgentAccounts } from './AgentAccounts';
import { useStayOn } from '../../hooks/useStayOn';
import { useAgentsSelector } from '../../lib/agentsStore';
import { defaultEngine, ENGINE_LABEL, engineUnavailable, type EngineInfo } from '../../lib/agents';

function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`settings-toggle ${on ? 'on' : 'off'}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={label}
    >
      <span className="settings-toggle-track">
        <span className="settings-toggle-thumb" />
      </span>
    </button>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-description">{description}</span>
      </div>
      {children}
    </div>
  );
}

const engineState = (e: EngineInfo) => {
  const missing = engineUnavailable(e);
  return missing === 'install'
    ? 'not installed'
    : missing === 'sign-in'
      ? 'not signed in'
      : 'ready';
};

const selectEngines = (s: { engines: EngineInfo[] }) => s.engines;

export function AgentsSettings({
  onOpenPhone,
  onOpenRemote,
}: {
  onOpenPhone: () => void;
  onOpenRemote: () => void;
}) {
  const { state: stayOn, change } = useStayOn();
  const engines = useAgentsSelector(selectEngines);
  const starts = engines.length > 0 ? defaultEngine(engines) : null;

  return (
    <div className="settings-modal-body agents-settings">
      <section className="settings-group" aria-labelledby="agents-settings-mac">
        <h3 className="settings-group__title" id="agents-settings-mac">
          On this Mac
        </h3>
        <AgentsDesktopSettings />
        {stayOn?.supported && (
          <div className="settings-section">
            <Row label="Keep this Mac awake" description="Agents pause while the Mac sleeps.">
              <Toggle
                on={stayOn.keepAwake}
                label="Keep this Mac awake"
                onChange={(on) => void change({ keepAwake: on })}
              />
            </Row>
            <Row
              label="Keep running when closed"
              description="Closing the window keeps agents going; ⌘Q still quits."
            >
              <Toggle
                on={stayOn.keepRunning}
                label="Keep running when closed"
                onChange={(on) => void change({ keepRunning: on })}
              />
            </Row>
            {stayOn.openAtLoginAvailable && (
              <Row label="Open at login" description="Reopens the app after a restart.">
                <Toggle
                  on={stayOn.openAtLogin}
                  label="Open at login"
                  onChange={(on) => void change({ openAtLogin: on })}
                />
              </Row>
            )}
          </div>
        )}
      </section>

      {starts && (
        <section className="settings-group" aria-labelledby="agents-settings-engines">
          <h3 className="settings-group__title" id="agents-settings-engines">
            Engines and models
          </h3>
          <div className="settings-section">
            <Row
              label={`New agents start on ${ENGINE_LABEL[starts]}`}
              description={engines
                .map((e) => `${ENGINE_LABEL[e.id] ?? e.label} ${engineState(e)}`)
                .join(' · ')}
            />
            <Row
              label="Models"
              description="Each agent uses its engine’s default model; pick another in Edit agent."
            />
            <Row
              label="Routines"
              description="On Claude Code, routines run on the fastest model unless the agent has its own."
            />
          </div>
        </section>
      )}

      {engines.some((e) => e.installed) && <AgentAccounts engines={engines} />}

      <section className="settings-group" aria-labelledby="agents-settings-notify">
        <h3 className="settings-group__title" id="agents-settings-notify">
          Notifications
        </h3>
        <div className="settings-section">
          <Row
            label="Replies and requests"
            description="A reply notifies once per turn; a request for your OK comes with a sound."
          />
          <Row
            label="Mute an agent"
            description="From its … menu. Muted agents still count in the Dock badge."
          />
        </div>
      </section>

      <section className="settings-group" aria-labelledby="agents-settings-away">
        <h3 className="settings-group__title" id="agents-settings-away">
          Away from your desk
        </h3>
        <div className="settings-section">
          <Row label="Phone" description="Talk to your agents and answer them from your phone.">
            <Button variant="secondary" data-settings-open="phone" onClick={onOpenPhone}>
              Open
            </Button>
          </Row>
          <Row
            label="Other assistants"
            description="Drive your agents from ChatGPT, Claude, Grok and others."
          >
            <Button variant="secondary" data-settings-open="remote" onClick={onOpenRemote}>
              Open
            </Button>
          </Row>
        </div>
      </section>
    </div>
  );
}
