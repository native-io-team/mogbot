/** The scenario registry. `?scenario=<id>`; unknown ids fall back to `dashboard`. */

import type { Scenario } from '../types';
import { agentsScenarios } from './agents';
import { agentsDesktopScenarios } from './agentsDesktop';
import { agentsProjectScenarios } from './agentsProject';
import { agentsWorkScenarios } from './agentsWork';
import { agentsLiveScenarios } from './agentsLive';
import { agentsResultsScenarios } from './agentsResults';
import { agentsRoomsScenarios } from './agentsRooms';
import { agentsTakeoverScenarios } from './agentsTakeover';
import { agentsStackScenarios } from './agentsStack';
import { agentsFirstWinScenarios } from './agentsFirstWin';
import { agentsStressScenarios } from './agentsStress';
import { agentsRequestsScenarios } from './agentsRequests';
import { agentsUsageScenarios } from './agentsUsage';
import { agentsLoginsScenarios } from './agentsLogins';
import { agentsPolicyScenarios } from './agentsPolicy';
import { agentsHeavyScenarios } from './agentsHeavy';
import { agentsTeamSetupScenarios } from './agentsTeamSetup';
import { agentsHeaderScenarios } from './agentsHeader';
import { appScenarios } from './app';
import { featureScenarios } from './features';
import { hostingScenarios } from './hosting';
import { hostingConnectScenarios } from './hostingConnect';
import { issueReportScenarios } from './issueReports';
import { layoutScenarios } from './layout';
import { migrationScenarios } from './migration';
import { phoneScenarios } from './phone';
import { phoneInstallScenarios } from './phoneInstall';
import { previewErrorScenarios } from './previewError';
import { remoteScenarios } from './remote';
import { teamScenarios } from './team';

export const scenarios: Scenario[] = [
  ...agentsScenarios,
  ...agentsDesktopScenarios,
  ...agentsProjectScenarios,
  ...agentsWorkScenarios,
  ...agentsLiveScenarios,
  ...agentsResultsScenarios,
  ...agentsRoomsScenarios,
  ...agentsTakeoverScenarios,
  ...agentsStackScenarios,
  ...agentsFirstWinScenarios,
  ...agentsStressScenarios,
  ...agentsRequestsScenarios,
  ...agentsUsageScenarios,
  ...agentsLoginsScenarios,
  ...agentsPolicyScenarios,
  ...agentsHeavyScenarios,
  ...agentsTeamSetupScenarios,
  ...agentsHeaderScenarios,
  ...appScenarios,
  ...featureScenarios,
  ...hostingScenarios,
  ...hostingConnectScenarios,
  ...issueReportScenarios,
  ...layoutScenarios,
  ...migrationScenarios,
  ...phoneScenarios,
  ...phoneInstallScenarios,
  ...previewErrorScenarios,
  ...remoteScenarios,
  ...teamScenarios,
];

export const DEFAULT_SCENARIO = 'dashboard';

export function findScenario(id: string | null): Scenario {
  return (
    scenarios.find((s) => s.id === id) ??
    scenarios.find((s) => s.id === DEFAULT_SCENARIO) ??
    scenarios[0]
  );
}
