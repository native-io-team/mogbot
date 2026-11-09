/**
 * Settings → Agents: everything about running agents, in one calm place.
 *
 * - **On this Mac**: the menu-bar icon and quick message
 *   (`AgentsDesktopSettings`), and what keeps agents going (keep awake, keep
 *   running when closed, open at login — `useStayOn`, read back from the
 *   thing itself), whether a stopped preview wakes its agent
 *   (`AgentPreviewFixSetting`), and slowing down on battery
 *   (`AgentLowPowerSetting`, `power.rs`).
 * - **Agents' browser**: the team's own Chrome on this Mac (on by default),
 *   and the two permissions a phone sign-in to Google needs
 *   (`AgentsBrowserSettings`, `agent_browser/`).
 * - **Your Chrome**: the user's own Chrome through the app's extension, for
 *   any engine (off by default), with its guided setup
 *   (`AgentsUserChromeSettings`, `user_chrome/`).
 * - **Independence**: how much agents do on their own, a four-stop slider
 *   (Careful, Steady, Bold, Unleashed), and what always asks at every stop
 *   (`AgentIndependenceSettings`, `agents/independence.rs`).
 * - **What agents can do**: the team's defaults, the presets, and "Reset
 *   everyone to …" (`AgentTeamPolicySettings`, `agents/policy.rs`). Chat is
 *   the first way to change them; this is the second.
 * - **Engines and models**: the engine and model new agents start on, a
 *   real setting (`AgentDefaultsSettings`), and what routines run on.
 *   Existing agents keep theirs; nothing shown that wasn't read.
 * - **Usage**: how agents use the plans' limits (Normal, Save my limits,
 *   Use it all before reset), what each account last reported, estimates
 *   from past runs, other compute here, and the spare-capacity list
 *   (`AgentsUsage`, `agents/inventory.rs`).
 * - **Accounts**: each engine's accounts, in the order turns try them when
 *   one runs out of usage (`AgentAccounts`, `agents/wallet.rs`).
 * - **Disk space**: free space when low, and each large agent home with
 *   "Free up space" (`AgentsDiskSettings`, `agents/disk.rs`).
 * - **Notifications**: what notifies, quiet hours (`AgentQuietHoursSetting`,
 *   `agents/quiet.rs`), and where to mute one agent.
 * - **Slack**: start agents from a Slack message, answered in the thread
 *   (`AgentsSlackSettings`, `agents/slack.rs`).
 * - **Phone and other assistants**: the way into each.
 *
 * Every description is one line.
 *
 * @module components/agents/AgentsSettings
 */

import { Button } from '../primitives/Button';
import { AgentsDesktopSettings } from './AgentsDesktopSettings';
import { AgentDefaultsSettings } from './AgentDefaultsSettings';
import { AgentAccounts } from './AgentAccounts';
import { AgentUsageSettings } from './AgentsUsage';
import { AgentIndependenceSettings } from './AgentIndependenceSettings';
import { DeclinedAppsSettings } from './DeclinedAppsSettings';
import { AgentsDiskSettings } from './AgentsDiskSettings';
import { AgentAdminSettings } from './AgentAdmin';
import { Row, Toggle } from './AgentSettingsRows';
import { SectionBoundary } from './AgentsErrorBoundary';
import { AgentTeamPolicySettings } from './AgentTeamPolicySettings';
import { AgentsBrowserSettings } from './AgentsBrowserSettings';
import { AgentsUserChromeSettings } from './AgentsUserChromeSettings';
import { AgentsSlackSettings } from './AgentsSlackSettings';
import { AgentPreviewFixSetting } from './AgentPreviewFixSetting';
import { AgentLowPowerSetting } from './AgentLowPowerSetting';
import { AgentQuietHoursSetting } from './AgentQuietHoursSetting';
import { useStayOn } from '../../hooks/useStayOn';
import { useAgentsSelector } from '../../lib/agentsStore';
import type { EngineInfo } from '../../lib/agents';

const selectEngines = (s: { engines: EngineInfo[] }) => s.engines;

export function AgentsSettings({
  onOpenPhone,
  onOpenRemote,
  onImport,
}: {
  onOpenPhone: () => void;
  onOpenRemote: () => void;
  /** Import agents: always here, once the first-run question is answered too. */
  onImport: () => void;
}) {
  const { state: stayOn, change } = useStayOn();
  const engines = useAgentsSelector(selectEngines);
  const hasDefaults = useAgentsSelector((s) => s.defaults !== null);

  return (
    <div className="settings-modal-body agents-settings">
      <section className="settings-group" aria-labelledby="agents-settings-mac">
        <h3 className="settings-group__title" id="agents-settings-mac">
          On this Mac
        </h3>
        <SectionBoundary name="desktop">
          <AgentsDesktopSettings />
        </SectionBoundary>
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
        <div className="settings-section">
          <SectionBoundary name="preview-fix">
            <AgentPreviewFixSetting />
          </SectionBoundary>
          <SectionBoundary name="low-power">
            <AgentLowPowerSetting />
          </SectionBoundary>
        </div>
      </section>

      <SectionBoundary name="browser">
        <AgentsBrowserSettings />
      </SectionBoundary>
      <SectionBoundary name="user-chrome">
        <AgentsUserChromeSettings />
      </SectionBoundary>

      <SectionBoundary name="independence">
        <AgentIndependenceSettings />
      </SectionBoundary>

      <SectionBoundary name="admin">
        <AgentAdminSettings />
      </SectionBoundary>
      <SectionBoundary name="team-policy">
        <AgentTeamPolicySettings />
      </SectionBoundary>

      {engines.length > 0 && hasDefaults && (
        <section className="settings-group" aria-labelledby="agents-settings-engines">
          <h3 className="settings-group__title" id="agents-settings-engines">
            Engines and models
          </h3>
          <SectionBoundary name="defaults">
            <AgentDefaultsSettings />
          </SectionBoundary>
          <div className="settings-section">
            <Row
              label="Routines"
              description="On Claude Code, routines run on the fastest model unless the agent has its own."
            />
          </div>
        </section>
      )}

      {engines.some((e) => e.installed) && (
        <SectionBoundary name="usage">
          <AgentUsageSettings />
        </SectionBoundary>
      )}

      {engines.some((e) => e.installed) && (
        <SectionBoundary name="accounts">
          <AgentAccounts engines={engines} />
        </SectionBoundary>
      )}

      <SectionBoundary name="declined-apps">
        <DeclinedAppsSettings />
      </SectionBoundary>

      <SectionBoundary name="disk">
        <AgentsDiskSettings />
      </SectionBoundary>

      <section className="settings-group" aria-labelledby="agents-settings-notify">
        <h3 className="settings-group__title" id="agents-settings-notify">
          Notifications
        </h3>
        <div className="settings-section">
          <Row
            label="Replies and requests"
            description="A reply notifies once per turn; a request for your OK comes with a sound."
          />
          <SectionBoundary name="quiet-hours">
            <AgentQuietHoursSetting />
          </SectionBoundary>
          <Row
            label="Mute an agent"
            description="From its … menu. Muted agents still count in the Dock badge."
          />
        </div>
      </section>

      <SectionBoundary name="slack">
        <AgentsSlackSettings />
      </SectionBoundary>

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
            label="Import agents"
            description="Bring the agents another assistant runs for you, with their memory and routines."
          >
            <Button variant="secondary" data-settings-open="import" onClick={onImport}>
              Import…
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
