/**
 * The agents' pages of the Settings window (`dashboard/SettingsModal.tsx`,
 * pages listed in `lib/settingsPages.ts`). Each page is its own scroll, so
 * nothing is twelve screens down; every group keeps its own component.
 *
 * - **Agents** (`AgentsPage`): the engine and model new agents start on
 *   (`AgentDefaultsSettings`), first; then this Mac (the menu-bar icon and
 *   quick message, `AgentsDesktopSettings`; keep awake, keep running when
 *   closed, open at login, read back from the thing itself, `useStayOn`;
 *   whether a stopped preview wakes its agent; slowing down on battery,
 *   `power.rs`), disk space (`AgentsDiskSettings`), and importing agents.
 * - **Independence** (`IndependencePage`): the one scale, the four-stop
 *   slider (Careful, Steady, Bold, Unleashed; `AgentIndependenceSettings`),
 *   what agents can reach (`AgentTeamPolicySettings`, `agents/policy.rs`),
 *   each agent's independence beyond its level (`OnItsOwnTeamSettings`,
 *   `agents/on_its_own.rs`), and admins (`AgentAdminSettings`).
 * - **Accounts & usage** (`AccountsPage`): the Usage view's own panel
 *   (`AgentsUsageView` `UsagePanel`), the one rendering of usage and accounts.
 * - **Phone** (`PhonePage`): the phone panel and Remote access, drawn on the page.
 * - **Notifications** (`NotificationsPage`): quiet hours (`agents/quiet.rs`)
 *   and the morning brief (`AgentMorningBriefSetting`, `agents/brief.rs`)
 *   first, then what notifies you and where to mute one agent.
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
import { UsagePanel } from './AgentsUsageView';
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
import { PhoneSettingsPanel } from '../phone/PhoneModal';
import { RemoteAccessSettingsPanel } from '../remote/RemoteAccessModal';
import { useStayOn } from '../../hooks/useStayOn';
import { useAgentsSelector } from '../../lib/agentsStore';
import type { EngineInfo } from '../../lib/agents';
import { COMPUTER, THIS_COMPUTER } from '../../lib/computer';

const selectEngines = (s: { engines: EngineInfo[] }) => s.engines;

/**
 * What new agents run on first (what people open this page for), then this
 * Mac, disk space, and importing agents.
 */
export function AgentsPage({ onImport }: { onImport: () => void }) {
  const { state: stayOn, change } = useStayOn();
  const engines = useAgentsSelector(selectEngines);
  const hasDefaults = useAgentsSelector((s) => s.defaults !== null);

  return (
    <div className="agents-settings">
      {engines.length > 0 && hasDefaults && (
        <section className="settings-group" aria-labelledby="agents-settings-engines">
          <h3 className="settings-group__title" id="agents-settings-engines">
            What agents run on
          </h3>
          <SectionBoundary name="defaults">
            <AgentDefaultsSettings />
          </SectionBoundary>
          <p className="settings-group__footnote">
            For new agents: each agent can pick its own model in Edit agent. On Claude Code,
            routines run on the fastest model unless the agent has its own.
          </p>
        </section>
      )}

      <section className="settings-group" aria-labelledby="agents-settings-mac">
        <h3 className="settings-group__title" id="agents-settings-mac">
          On {THIS_COMPUTER}
        </h3>
        <SectionBoundary name="desktop">
          <AgentsDesktopSettings />
        </SectionBoundary>
        {stayOn?.supported && (
          <div className="settings-section">
            <Row
              label={`Keep ${THIS_COMPUTER} awake`}
              description={`Agents pause while the ${COMPUTER} sleeps.`}
            >
              <Toggle
                on={stayOn.keepAwake}
                label={`Keep ${THIS_COMPUTER} awake`}
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
 * Usage and accounts: the Usage view's own rendering (`UsagePanel`), not a
 * second one, so the two can never disagree about a reading, a name or the
 * order.
 */
export function AccountsPage() {
  const engines = useAgentsSelector(selectEngines);
  const loaded = useAgentsSelector((s) => s.loaded);
  const any = engines.some((e) => e.installed);
  return (
    <div className="agents-settings">
      {any && (
        <SectionBoundary name="usage">
          <UsagePanel inSettings />
        </SectionBoundary>
      )}
      {loaded && !any && (
        <p className="settings-row-description">
          Accounts and usage show here once Claude Code or Codex is set up on {THIS_COMPUTER}.
        </p>
      )}
    </div>
  );
}

/**
 * Away from the desk: the phone panel and Remote access, on the page itself
 * (they used to be two "Open" buttons, each a dialog on top of this one).
 */
export function PhonePage() {
  return (
    <div className="agents-settings">
      <section className="settings-group" aria-labelledby="agents-settings-phone">
        <h3 className="settings-group__title" id="agents-settings-phone">
          Your phone
        </h3>
        <SectionBoundary name="phone">
          <PhoneSettingsPanel />
        </SectionBoundary>
      </section>
      <section className="settings-group" aria-labelledby="agents-settings-remote">
        <h3 className="settings-group__title" id="agents-settings-remote">
          Other assistants
        </h3>
        <SectionBoundary name="remote">
          <RemoteAccessSettingsPanel />
        </SectionBoundary>
      </section>
    </div>
  );
}

/**
 * What can be set first (quiet hours, the morning brief), then what notifies
 * you and where, which are lines rather than switches.
 */
export function NotificationsPage() {
  return (
    <div className="agents-settings">
      <section className="settings-group" aria-labelledby="agents-settings-quiet">
        <h3 className="settings-group__title" id="agents-settings-quiet">
          Quiet hours and the morning brief
        </h3>
        <div className="settings-section">
          <SectionBoundary name="quiet-hours">
            <AgentQuietHoursSetting />
          </SectionBoundary>
          <SectionBoundary name="morning-brief">
            <AgentMorningBriefSetting />
          </SectionBoundary>
        </div>
      </section>
      <section className="settings-group" aria-labelledby="agents-settings-notify">
        <h3 className="settings-group__title" id="agents-settings-notify">
          What notifies you
        </h3>
        <div className="settings-section">
          <Row
            label="Replies"
            description="One notification when a turn ends, with its latest line. None for the chat you’re looking at."
          />
          <Row
            label="Requests for your OK"
            description="At once, with a sound, even in quiet hours."
          />
          <Row
            label="Your phone"
            description={`While you’re using ${THIS_COMPUTER}, only ${THIS_COMPUTER} notifies. Away from it, a paired phone gets the same ones.`}
          />
          <Row
            label="Dock badge"
            description="How many agents need you: a request to answer, or a turn that failed. Unread replies don’t count."
          />
          <Row
            label="Mute an agent"
            description="From its … menu. Nothing from it notifies, requests included, here or on your phone. It still counts in the Dock badge."
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
