/**
 * What a turn did, under the message it ended on: one quiet folded line
 * ("Worked 6 min · 23 steps · edited 2 files") that opens into the steps in
 * order, each with its time into the turn and any screenshot it produced.
 * While the agent works the same list hangs above the working line, which
 * stays the current step while its call runs (`WorkingIndicator`, `liveSteps`).
 * A step the user declined, or that failed, says so in words and is drawn
 * quieter (`data-outcome`).
 *
 * Everything shown is what the backend recorded from the engine's own output
 * (`agents::work`); a turn with no steps has no line at all.
 *
 * @module components/agents/AgentWork
 */

import { memo, useId, useState, type ComponentType } from 'react';
import {
  AgentsIcon,
  CameraIcon,
  ChevronRightIcon,
  CommentIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  ListIcon,
  PencilIcon,
  PuzzleIcon,
  SearchIcon,
  ShieldCheckIcon,
  TerminalIcon,
} from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import type { Agent, TurnWork, WorkStep } from '../../lib/agents';
import {
  earlierSteps,
  liveSteps,
  liveSummary,
  rememberLiveOpen,
  stepOffset,
  wasOpenLive,
  workSummary,
} from '../../lib/agentWork';
import { MessageAttachments } from './AgentAttachments';
import { useAgentProjects } from './AgentProject';

type IconComponent = ComponentType<{ size?: number }>;

const STEP_ICON: Record<string, IconComponent> = {
  read: FileTextIcon,
  edit: PencilIcon,
  search: SearchIcon,
  web: GlobeIcon,
  command: TerminalIcon,
  message: CommentIcon,
  approval: ShieldCheckIcon,
  screenshot: CameraIcon,
  plan: ListIcon,
  delegate: AgentsIcon,
  project: FolderIcon,
  tool: PuzzleIcon,
};

/** A kind a newer Mac sent that this build doesn't know reads as a tool. */
function StepIcon({ kind }: { kind: string }) {
  const Icon = STEP_ICON[kind] ?? PuzzleIcon;
  return (
    <span className="agent-work__icon" aria-hidden>
      <Icon size={12} />
    </span>
  );
}

function StepRow({ step, startedAt, agent }: { step: WorkStep; startedAt: number; agent: Agent }) {
  return (
    <li className="agent-work__step" data-kind={step.kind} data-outcome={step.outcome}>
      <StepIcon kind={step.kind} />
      <span className="agent-work__label" title={step.label}>
        {step.label}
      </span>
      <time className="agent-work__time" dateTime={new Date(step.at).toISOString()}>
        {stepOffset(step, startedAt)}
      </time>
      {step.image && (
        <div className="agent-work__shot">
          <MessageAttachments agent={agent} attachments={[step.image]} side="agent" />
        </div>
      )}
    </li>
  );
}

interface StepListProps {
  work: TurnWork;
  agent: Agent;
  /** While it works: what the working line under the list says (`liveSteps`). */
  live?: { activity: string | null | undefined };
}

/** The steps, oldest first, and the files the turn edited. */
function StepList({ work, agent, live }: StepListProps) {
  const steps = live ? liveSteps(work, live.activity) : work.steps;
  const earlier = earlierSteps(work);
  const files = work.files ?? [];
  const more = work.fileCount - files.length;
  return (
    <>
      <ol className="agent-work__steps">
        {earlier > 0 && (
          <li className="agent-work__step agent-work__step--earlier">
            {earlier === 1 ? '1 earlier step' : `${earlier} earlier steps`}
          </li>
        )}
        {steps.map((step, i) => (
          <StepRow key={`${step.at}-${i}`} step={step} startedAt={work.startedAt} agent={agent} />
        ))}
      </ol>
      {!live && files.length > 0 && (
        <p className="agent-work__files">
          <span className="agent-work__files-label">Edited</span> {files.join(', ')}
          {more > 0 && ` and ${more} more`}
        </p>
      )}
    </>
  );
}

/**
 * A real way in, or nothing: the project a bound agent works in opens in the
 * workspace, where its session and preview are.
 */
function OpenProject({ agent }: { agent: Agent }) {
  const ctx = useAgentProjects();
  if (!agent.project || !ctx) return null;
  const project = agent.project;
  const name = ctx.projects?.find((p) => p.path === project)?.name;
  return (
    <TextButton
      tabIndex={0}
      className="agent-work__open"
      title={name ? `Open ${name} in the workspace` : 'Open the project in the workspace'}
      onClick={() => ctx.openProject(project)}
    >
      Open project
    </TextButton>
  );
}

/** The chevron and its words; the same control folded and open. */
function Toggle({
  open,
  label,
  controls,
  onToggle,
}: {
  open: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <TextButton
      tabIndex={0}
      className="agent-work__toggle"
      aria-expanded={open}
      aria-controls={controls}
      data-open={open || undefined}
      leftIcon={<ChevronRightIcon size={12} />}
      onClick={onToggle}
    >
      {label}
    </TextButton>
  );
}

interface WorkTimelineProps {
  work: TurnWork;
  agent: Agent;
}

/** Under a finished turn's last message: folded unless it was open live. */
export const WorkTimeline = memo(function WorkTimeline({ work, agent }: WorkTimelineProps) {
  const [open, setOpen] = useState(() => wasOpenLive(agent.id, work.startedAt));
  // Mounted from the first open on, so closing animates rather than blanking.
  const [ever, setEver] = useState(open);
  const id = useId();
  if (work.stepCount === 0) return null;
  return (
    <div className="agent-work" data-open={open || undefined}>
      <div className="agent-work__head">
        <Toggle
          open={open}
          label={workSummary(work)}
          controls={id}
          onToggle={() => {
            setEver(true);
            setOpen((o) => !o);
          }}
        />
      </div>
      <div className="agent-work__body" id={id} aria-hidden={!open}>
        <div className="agent-work__inner">
          {(open || ever) && <StepList work={work} agent={agent} />}
        </div>
      </div>
    </div>
  );
});

interface LiveWorkProps {
  work: TurnWork | undefined;
  agent: Agent | undefined;
  /** What the working line says now. */
  activity: string | null | undefined;
  /** The working line collapsing at the turn's end: nothing opens now. */
  leaving?: boolean;
}

/** The toggle beside the working line, and the steps so far above it. */
export function useLiveWork({ work, agent, activity, leaving }: LiveWorkProps) {
  const [openAt, setOpenAt] = useState<number | null>(() =>
    work && agent && wasOpenLive(agent.id, work.startedAt) ? work.startedAt : null
  );
  const [ever, setEver] = useState(openAt !== null);
  const id = useId();
  // A new turn starts folded, whatever the last one did.
  const open = Boolean(work && openAt === work.startedAt && !leaving);
  if (!work || !agent || work.stepCount === 0) return { toggle: null, list: null, open: false };
  const toggle = (
    <Toggle
      open={open}
      label={liveSummary(work)}
      controls={id}
      onToggle={() => {
        const next = !open;
        setEver(true);
        setOpenAt(next ? work.startedAt : null);
        rememberLiveOpen(agent.id, work.startedAt, next);
      }}
    />
  );
  const list = (
    <div className="agent-work agent-work--live" data-open={open || undefined}>
      <div className="agent-work__body" id={id} aria-hidden={!open}>
        <div className="agent-work__inner">
          {(open || ever) && (
            <>
              <StepList work={work} agent={agent} live={{ activity }} />
              <OpenProject agent={agent} />
            </>
          )}
        </div>
      </div>
    </div>
  );
  return { toggle, list, open };
}
