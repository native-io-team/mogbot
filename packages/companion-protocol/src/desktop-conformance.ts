/**
 * Fails `tsc` when the companion's copy of a desktop type drifts from the
 * desktop's own (src/lib/agents.ts, src/lib/git.ts, src/lib/errors.ts).
 * Type-only: nothing here exists at runtime, and the package's index doesn't
 * export it, so the Expo app never sees the desktop imports.
 *
 * Checked by `pnpm typecheck` (which includes this package's tsconfig).
 */

import type * as Desktop from '../../../src/lib/agents';
import type { FileDiff as DesktopFileDiff } from '../../../src/lib/git';
import type { CommandError as DesktopCommandError } from '../../../src/lib/errors';
import type * as DesktopSecrets from '../../../src/lib/agentSecrets';
import type * as Wire from './model';
import type { CommandError } from './frames';

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** The desktop's take-over as the phone gets it: without the Mac's terminal id. */
type PhoneTakeover = Omit<Desktop.AgentTakeover, 'ptySession'>;

export type Conformance = [
  // `watches`: the phone gets "When…" routines apart (`phone_overview`); the desk keeps them in `checkIns`.
  Assert<Same<Omit<Wire.Agent, 'takeover' | 'watches'>, Omit<Desktop.Agent, 'takeover'>>>,
  Assert<Same<Wire.Agent['takeover'], PhoneTakeover | undefined>>,
  Assert<Same<Wire.AgentMessage, Desktop.AgentMessage>>,
  Assert<Same<Omit<Wire.AgentsOverview, 'agents'>, Omit<Desktop.AgentsOverview, 'agents'>>>,
  Assert<Same<Wire.AgentsOverview['agents'], Wire.Agent[]>>,
  Assert<Same<Wire.AgentStatus, Desktop.AgentStatus>>,
  Assert<Same<Wire.ContextFill, Desktop.ContextFill>>,
  Assert<Same<Wire.AgentTakeover, PhoneTakeover>>,
  Assert<Same<Wire.Approval, Desktop.Approval>>,
  Assert<Same<Wire.Attachment, Desktop.Attachment>>,
  Assert<Same<Wire.SharedFile, Desktop.SharedFile>>,
  Assert<Same<Wire.CheckIn, Desktop.CheckIn>>,
  Assert<Same<Wire.CheckInRun, Desktop.CheckInRun>>,
  Assert<Same<Wire.EngineInfo, Desktop.EngineInfo>>,
  Assert<Same<Wire.NewAgentDefaults, Desktop.NewAgentDefaults>>,
  Assert<Same<Wire.NewAgentDefaultsChange, Desktop.NewAgentDefaultsChange>>,
  Assert<Same<Wire.SessionPrompt, Desktop.SessionPrompt>>,
  Assert<Same<Wire.SecretRequest, DesktopSecrets.SecretRequest>>,
  Assert<Same<Wire.AgentSecret, DesktopSecrets.AgentSecret>>,
  Assert<Same<Wire.MemoryView, Desktop.MemoryView>>,
  Assert<Same<Wire.MemoryChange, Desktop.MemoryChange>>,
  Assert<Same<Wire.SchedulePreview, Desktop.SchedulePreview>>,
  Assert<Same<Wire.NewAgentInput, Desktop.NewAgentInput>>,
  Assert<Same<Wire.UpdateAgentInput, Desktop.UpdateAgentInput>>,
  Assert<Same<Wire.SearchHit, Desktop.SearchHit>>,
  Assert<Same<Wire.UsageSummary, Desktop.UsageSummary>>,
  Assert<Same<Wire.Quota, Desktop.Quota>>,
  Assert<Same<Wire.PasteImportPreview, Desktop.PasteImportPreview>>,
  Assert<Same<Wire.ImportSummary, Desktop.ImportSummary>>,
  Assert<Same<Wire.ImportTalk, Desktop.ImportTalk>>,
  Assert<Same<Wire.ImportApplied, Desktop.ImportApplied>>,
  Assert<Same<Wire.ConnectorCard, Desktop.ConnectorCard>>,
  Assert<Same<Wire.FileDiff, DesktopFileDiff>>,
  Assert<Same<CommandError, DesktopCommandError>>,
  Assert<Same<typeof Wire.MAX_ATTACHMENTS, typeof Desktop.MAX_ATTACHMENTS>>,
  Assert<Same<typeof Wire.MAX_ATTACHMENT_BYTES, typeof Desktop.MAX_ATTACHMENT_BYTES>>,
];
