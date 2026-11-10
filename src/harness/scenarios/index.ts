/** The scenario registry. `?scenario=<id>`; unknown ids fall back to `dashboard`. */

import type { Scenario } from '../types';
import { agentsScenarios } from './agents';
import { agentsDesktopScenarios } from './agentsDesktop';
import { agentsBriefScenarios } from './agentsBrief';
import { agentsProjectScenarios } from './agentsProject';
import { agentsWorkScenarios } from './agentsWork';
import { agentsDeskScenarios } from './agentsDesk';
import { agentsLiveScenarios } from './agentsLive';
import { agentsResultsScenarios } from './agentsResults';
import { agentsShowWorkScenarios } from './agentsShowWork';
import { agentsBlocksScenarios } from './agentsBlocks';
import { agentsPageScenarios } from './agentsPage';
import { agentsBriefBlocksScenarios } from './agentsBriefBlocks';
import { agentsPreviewScenarios } from './agentsPreview';
import { agentsRoomsScenarios } from './agentsRooms';
import { agentsTakeoverScenarios } from './agentsTakeover';
import { agentsStackScenarios } from './agentsStack';
import { agentsFirstWinScenarios } from './agentsFirstWin';
import { agentsStartersScenarios } from './agentsStarters';
import { agentsStressScenarios } from './agentsStress';
import { agentsTortureScenarios } from './agentsTorture';
import { agentsRequestsScenarios } from './agentsRequests';
import { agentsUsageScenarios } from './agentsUsage';
import { agentsUsageViewScenarios } from './agentsUsageView';
import { agentsLoginsScenarios } from './agentsLogins';
import { agentsMacAppsScenarios } from './agentsMacApps';
import { agentsPolicyScenarios } from './agentsPolicy';
import { agentsRecipeScenarios } from './agentsRecipe';
import { agentsSkillsScenarios } from './agentsSkills';
import { settingsWindowScenarios } from './settingsWindow';
import { agentsStepsScenarios } from './agentsSteps';
import { agentsProbeScenarios } from './agentsProbe';
import { agentsFailureScenarios } from './agentsFailures';
import { agentsStepInScenarios } from './agentsStepIn';
import { agentsHeavyScenarios } from './agentsHeavy';
import { agentsCrossoverScenarios } from './agentsCrossover';
import { agentsTeamSetupScenarios } from './agentsTeamSetup';
import { agentsHeaderScenarios } from './agentsHeader';
import { agentsAccountsScenarios } from './agentsAccounts';
import { agentsSidebarFootScenarios } from './agentsSidebarFoot';
import { agentsKeysScenarios } from './agentsKeys';
import { agentsInFlightScenarios } from './agentsInFlight';
import { appScenarios } from './app';
import { onboardingFlowScenarios } from './onboardingFlow';
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
import { projectsAtWorkScenarios } from './projectsAtWork';
import { projectsDashboardScenarios } from './projectsDashboard';
import { connectiveScenarios } from './connective';

export const scenarios: Scenario[] = [
  ...agentsScenarios,
  ...connectiveScenarios,
  ...agentsKeysScenarios,
  ...agentsInFlightScenarios,
  ...agentsDesktopScenarios,
  ...agentsBriefScenarios,
  ...agentsProjectScenarios,
  ...agentsWorkScenarios,
  ...agentsDeskScenarios,
  ...agentsLiveScenarios,
  ...agentsResultsScenarios,
  ...agentsShowWorkScenarios,
  ...agentsBlocksScenarios,
  ...agentsPageScenarios,
  ...agentsBriefBlocksScenarios,
  ...agentsPreviewScenarios,
  ...agentsRoomsScenarios,
  ...agentsTakeoverScenarios,
  ...agentsStackScenarios,
  ...agentsFirstWinScenarios,
  ...agentsStartersScenarios,
  ...agentsStressScenarios,
  ...agentsTortureScenarios,
  ...agentsRequestsScenarios,
  ...agentsUsageScenarios,
  ...agentsUsageViewScenarios,
  ...agentsLoginsScenarios,
  ...agentsMacAppsScenarios,
  ...agentsPolicyScenarios,
  ...agentsRecipeScenarios,
  ...agentsSkillsScenarios,
  ...settingsWindowScenarios,
  ...agentsStepsScenarios,
  ...agentsProbeScenarios,
  ...agentsFailureScenarios,
  ...agentsStepInScenarios,
  ...agentsHeavyScenarios,
  ...agentsCrossoverScenarios,
  ...agentsTeamSetupScenarios,
  ...agentsHeaderScenarios,
  ...agentsAccountsScenarios,
  ...agentsSidebarFootScenarios,
  ...appScenarios,
  ...projectsDashboardScenarios,
  ...onboardingFlowScenarios,
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
  ...projectsAtWorkScenarios,
];

export const DEFAULT_SCENARIO = 'dashboard';

export function findScenario(id: string | null): Scenario {
  return (
    scenarios.find((s) => s.id === id) ??
    scenarios.find((s) => s.id === DEFAULT_SCENARIO) ??
    scenarios[0]
  );
}
