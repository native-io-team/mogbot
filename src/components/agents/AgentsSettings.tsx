/**
 * The agents' pages of the Settings window (`dashboard/SettingsModal.tsx`,
 * pages listed in `lib/settingsPages.ts`). Each page is its own scroll, so
 * nothing is twelve screens down; every group keeps its own component.
 *
 * - **Agents** (`AgentsPage`): this Mac (the menu-bar icon and quick message,
 *   `AgentsDesktopSettings`; keep awake, keep running when closed, open at
 *   login, read back from the thing itself, `useStayOn`; whether a stopped
 *   preview wakes its agent; slowing down on battery, `power.rs`), the
 *   engine and model new agents start on (`AgentDefaultsSettings`), disk
 *   space (`AgentsDiskSettings`), and importing agents.
 * - **Independence** (`IndependencePage`): the one scale, the four-stop
 *   slider (Careful, Steady, Bold, Unleashed; `AgentIndependenceSettings`),
 *   what agents can reach (`AgentTeamPolicySettings`, `agents/policy.rs`),
 *   each agent's independence beyond its level (`OnItsOwnTeamSettings`,
 *   `agents/on_its_own.rs`), and admins (`AgentAdminSettings`).
 * - **Accounts & usage** (`AccountsPage`): a slot for the usage and accounts
 *   groups (`AgentsUsage`, `AgentAccounts`), whose content is their own.
 * - **Phone** (`PhonePage`): the phone app and other assistants.
 * - **Notifications** (`NotificationsPage`): what notifies, quiet hours
 *   (`agents/quiet.rs`), the morning brief
 *   (`AgentMorningBriefSetting`, `agents/brief.rs`), and where to mute one agent.
 * - **Chrome** (`ChromePage`): the agents' own browser and Your Chrome.
 * - **Apps** (`AppsPage`): Slack (`agents/slack.rs`) and apps you said no to.
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
import { OnItsOwnTeamSettings } from './AgentOnItsOwn';
import { AgentsBrowserSettings } from './AgentsBrowserSettings';
import { AgentsUserChromeSettings } from './AgentsUserChromeSettings';
import { AgentsSlackSettings } from './AgentsSlackSettings';
import { AgentPreviewFixSetting } from './AgentPreviewFixSetting';
import { AgentLowPowerSetting } from './AgentLowPowerSetting';
import { AgentQuietHoursSetting } from './AgentQuietHoursSetting';
import { AgentMorningBriefSetting } from './AgentMorningBriefSetting';
import { useStayOn } from '../../hooks/useStayOn';
import { useAgentsSelector } from '../../lib/agentsStore';
import type { EngineInfo } from '../../lib/agents';

const selectEngines = (s: { engines: EngineInfo[] }) => s.engines;

/** This Mac, engines and models, disk space, and importing agents. */
export function AgentsPage({ onImport }: { onImport: () => void }) {
  const { state: stayOn, change } = useStayOn();
  const engines = useAgentsSelector(selectEngines);
  const hasDefaults = useAgentsSelector((s) => s.defaults !== null);

  return (
    <div className="agents-settings">
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

      <SectionBoundary name="disk">
        <AgentsDiskSettings />
      </SectionBoundary>

      <section className="settings-group" aria-labelledby="agents-settings-import">
        <h3 className="settings-group__title" id="agents-settings-import">
          Bring agents in
        </h3>
        <div className="settings-section">
          <Row
            label="Import agents"
            description="Bring the agents another assistant runs for you, with their memory and routines."
          >
            <Button variant="secondary" data-settings-open="import" onClick={onImport}>
              Import…
            </Button>
          </Row>
        </div>
      </section>
    </div>
  );
}

/** The one scale, what it reaches, each agent beyond its level, and admins. */
export function IndependencePage() {
  return (
    <div className="agents-settings">
      <SectionBoundary name="independence">
        <AgentIndependenceSettings />
      </SectionBoundary>
      <SectionBoundary name="team-policy">
        <AgentTeamPolicySettings />
      </SectionBoundary>
      <SectionBoundary name="on-its-own">
        <OnItsOwnTeamSettings />
      </SectionBoundary>
      <SectionBoundary name="admin">
        <AgentAdminSettings />
      </SectionBoundary>
    </div>
  );
}

/**
 * Usage and accounts: a slot. What's inside is the usage and accounts
 * groups' own (`AgentsUsage`, `AgentAccounts`); this page only places them.
 */
export function AccountsPage() {
  const engines = useAgentsSelector(selectEngines);
  const loaded = useAgentsSelector((s) => s.loaded);
  const any = engines.some((e) => e.installed);
  return (
    <div className="agents-settings">
      {any && (
        <SectionBoundary name="usage">
          <AgentUsageSettings />
        </SectionBoundary>
      )}
      {any && (
        <SectionBoundary name="accounts">
          <AgentAccounts engines={engines} />
        </SectionBoundary>
      )}
      {loaded && !any && (
        <p className="settings-row-description">
          Accounts and usage show here once Claude Code or Codex is set up on this Mac.
        </p>
      )}
    </div>
  );
}

/** Away from the desk: the phone app and other assistants. */
export function PhonePage({
  onOpenPhone,
  onOpenRemote,
}: {
  onOpenPhone: () => void;
  onOpenRemote: () => void;
}) {
  return (
    <div className="agents-settings">
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

export function NotificationsPage() {
  return (
    <div className="agents-settings">
      <section className="settings-group" aria-labelledby="agents-settings-notify">
        <h3 className="settings-group__title" id="agents-settings-notify">
          From your agents
        </h3>
        <div className="settings-section">
          <Row
            label="Replies and requests"
            description="A reply notifies once per turn; a request for your OK comes with a sound."
          />
          <SectionBoundary name="quiet-hours">
            <AgentQuietHoursSetting />
          </SectionBoundary>
          <SectionBoundary name="morning-brief">
            <AgentMorningBriefSetting />
          </SectionBoundary>
          <Row
            label="Mute an agent"
            description="From its … menu. Muted agents still count in the Dock badge."
          />
        </div>
      </section>
    </div>
  );
}

export function ChromePage() {
  return (
    <div className="agents-settings">
      <SectionBoundary name="browser">
        <AgentsBrowserSettings />
      </SectionBoundary>
      <SectionBoundary name="user-chrome">
        <AgentsUserChromeSettings />
      </SectionBoundary>
    </div>
  );
}

export function AppsPage() {
  return (
    <div className="agents-settings">
      <SectionBoundary name="slack">
        <AgentsSlackSettings />
      </SectionBoundary>
      <SectionBoundary name="declined-apps">
        <DeclinedAppsSettings />
      </SectionBoundary>
    </div>
  );
}
