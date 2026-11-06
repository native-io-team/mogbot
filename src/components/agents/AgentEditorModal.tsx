/**
 * Create a new agent, or edit one. Creating starts with "Start from": blank,
 * or a ready-made agent (`lib/agentTemplates`) that fills in the fields below
 * with its briefing, which stays editable. Up front: a name, what it should do and
 * what it should know; the avatar beside the name opens its look (shape,
 * face, colour). What it runs on (a choice only once two
 * engines are installed; otherwise a quiet "Also use …" at the foot), model,
 * project and apps sit under Advanced, because most agents are created by
 * the Chief of Staff and briefed in conversation.
 *
 * @module components/agents/AgentEditorModal
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import { ErrorIcon } from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextArea, TextField } from '../primitives/TextField';
import { TextButton } from '../primitives/TextButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { AgentProjectField } from './AgentProject';
import { AgentMemory } from './AgentMemory';
import { AgentAvatar } from './AgentAvatar';
import { AgentLookPicker } from './AgentLookPicker';
import { freeLook, lookFor, type AgentLook } from '../../../packages/companion-protocol/src/avatar';
import { AgentReach } from './AgentReach';
import { AgentPolicy } from './AgentPolicy';
import { AgentEngineField, AgentEngineMore } from './AgentEngine';
import { useQuotaLines } from './AgentsQuota';
import { ChevronRightIcon } from '@/components/icons';
import {
  AGENT_COLORS,
  COST_BASIS_NOTE,
  type AgentEngine,
  createAgent,
  discardCopy,
  ENGINE_LABEL,
  folderName,
  keepCopy,
  newAgentEngine,
  newAgentModel,
  formatContext,
  formatUsage,
  getAgentInstructions,
  getAgentUsage,
  modelChoices,
  onClaudePlan,
  revokePermission,
  routineWeekLine,
  SCOPE_KIND_LABEL,
  sumTotals,
  updateAgent,
  type Agent,
  type PermissionRule,
  type UsageSummary,
  type UsageTotals,
} from '../../lib/agents';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { getAgentsSnapshot, useAgentsSelector } from '../../lib/agentsStore';
import { useAsyncState } from '../../hooks/useAsyncState';
import { AccentScope } from '../../contexts/AccentScopeContext';
import { AdminSwitch } from './AgentAdmin';
import {
  findTemplate,
  needsLine,
  ROLE_TEMPLATES,
  templateInstructions,
  type RoleTemplate,
} from '../../lib/agentTemplates';

/**
 * This week and all time, as its engine reported them; nothing before any
 * turn. Then how full its conversation is, only when the engine said.
 */
function UsageLines({ usage, agent }: { usage: UsageSummary | null; agent: Agent | null }) {
  // On a Claude plan a dollar figure is a list price, not the bill: tokens instead.
  const onPlan = onClaudePlan(useQuotaLines());
  const week = usage && formatUsage(usage.week, onPlan);
  const allTime = usage && formatUsage(usage.allTime, onPlan);
  const routines = routineWeekLine(sumTotals((usage?.routines ?? []).map((r) => r.week)), onPlan);
  const context = agent && formatContext(agent);
  if (!allTime && !context) return null;
  const priced = (t: UsageTotals | undefined) =>
    !onPlan && t && t.pricedTurns + (t.pricedChecks ?? 0) > 0 ? COST_BASIS_NOTE : undefined;
  return (
    <dl className="agent-editor__usage">
      {allTime && (
        <>
          <dt>This week</dt>
          <dd title={priced(usage?.week)}>{week ?? 'No turns'}</dd>
          {routines && (
            <>
              <dt>Its routines</dt>
              <dd>{routines}</dd>
            </>
          )}
          <dt>All time</dt>
          <dd title={priced(usage?.allTime)}>{allTime}</dd>
        </>
      )}
      {context && (
        <>
          <dt>Conversation</dt>
          <dd>{context}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * What it can use, as its engine listed it for its last turn
 * (`agents/capabilities.rs`). Nothing is claimed before a turn has said.
 */
function CanDo({ agent }: { agent: Agent }) {
  const lines = agent.capabilities?.lines ?? [];
  return (
    <div className="agent-editor__label" role="group" aria-label={`What ${agent.name} can do`}>
      What {agent.name} can do
      {lines.length === 0 ? (
        <p className="agent-editor__hint">
          Shown after its first turn, from what {ENGINE_LABEL[agent.engine]} says it can use.
        </p>
      ) : (
        <dl className="agent-editor__usage agent-editor__can-do">
          {lines.map((line) => (
            <Fragment key={line.what}>
              <dt>{line.what}</dt>
              <dd>{line.detail}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * What this agent may do without asking, each with Revoke. Revoking is
 * immediate, not part of Save: it's a permission, not a draft.
 */
function Permissions({ agent }: { agent: Agent }) {
  const [rules, setRules] = useState<PermissionRule[]>(agent.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const revoke = async (rule: PermissionRule) => {
    setError(null);
    try {
      await revokePermission(agent.id, rule.id);
      setRules((list) => list.filter((r) => r.id !== rule.id));
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  };
  return (
    <div className="agent-editor__label" role="group" aria-label="Permissions">
      Permissions
      {rules.length === 0 ? (
        <p className="agent-editor__hint">
          Nothing is always allowed. Choose “Always allow” on a request in the chat to add one.
        </p>
      ) : (
        <ul className="agent-permissions">
          {rules.map((rule) => (
            <li key={rule.id} className="agent-permissions__rule">
              <span className="agent-permissions__what">
                {SCOPE_KIND_LABEL[rule.kind] && `${SCOPE_KIND_LABEL[rule.kind]} `}
                {rule.kind.startsWith('command') ? <code>{rule.label}</code> : rule.label}
              </span>
              <TextButton
                tabIndex={0}
                className="agent-permissions__revoke"
                onClick={() => void revoke(rule)}
              >
                Revoke
              </TextButton>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}
    </div>
  );
}

interface AgentEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Edit this agent; omit to create one. */
  agent?: Agent | null;
  onSaved: (agentId: string) => void;
  onDelete?: (agent: Agent) => void;
  /** Colours other agents already wear, so a new one starts on a free one. */
  takenColors?: string[];
  /** Open "Apps your agents can use" over the editor. */
  onOpenApps?: () => void;
  /** Editing: open on its memory rather than its settings. */
  initialTab?: EditorTab;
  /** Install or sign in to an engine that isn't ready, over the editor. */
  onSetUpEngine?: (engine: AgentEngine, step: 'install' | 'sign-in') => void;
  /** Creating: close and draft the request in the Chief of Staff's chat instead. */
  onAskChief?: () => void;
  /** "Change in chat": close and draft a settings request in the Chief of Staff's chat. */
  onAskInChat?: (text: string) => void;
  /** Creating: open on this ready-made agent (an id from `ROLE_TEMPLATES`). */
  initialTemplate?: string | null;
}

export type EditorTab = 'agent' | 'memory';

/** A template's own colour, unless another agent already wears it. */
function templateColor(template: RoleTemplate | null, taken: string[] = []): string | null {
  return template && !taken.includes(template.color) ? template.color : null;
}

/** The first colour nobody has yet; white and gray are left for the user to pick. */
function freeColor(taken: string[] = []): string {
  return AGENT_COLORS.find((c) => c !== 'white' && c !== 'gray' && !taken.includes(c)) ?? 'purple';
}

export function AgentEditorModal({
  isOpen,
  onClose,
  agent,
  onSaved,
  onDelete,
  takenColors,
  onOpenApps,
  initialTab = 'agent',
  onSetUpEngine,
  onAskChief,
  onAskInChat,
  initialTemplate,
}: AgentEditorModalProps) {
  const editing = Boolean(agent);
  const [tab, setTab] = useState<EditorTab>(initialTab);
  // Keyed by the caller per open, so these start fresh each time.
  const first = agent ? null : findTemplate(initialTemplate);
  const [template, setTemplate] = useState<RoleTemplate | null>(first);
  const [name, setName] = useState(agent?.name ?? first?.name ?? '');
  const [color, setColor] = useState<string>(
    () => agent?.color ?? templateColor(first, takenColors) ?? freeColor(takenColors)
  );
  // Editing: what it wears now. Creating: a shape nobody else wears yet, so
  // the preview is exactly what the new agent gets.
  const [initialLook] = useState<AgentLook>(() =>
    agent
      ? lookFor(agent)
      : freeLook(
          getAgentsSnapshot().agents.map((a) => lookFor(a)),
          String(Date.now())
        )
  );
  const [look, setLook] = useState<AgentLook>(initialLook);
  const lookChanged = look.shape !== initialLook.shape || look.face !== initialLook.face;
  const [showLook, setShowLook] = useState(false);
  const [role, setRole] = useState(agent?.role ?? first?.role ?? '');
  const [instructions, setInstructions] = useState(first ? templateInstructions(first) : '');

  /**
   * Another starting point. A field still showing what the last one put
   * there (or nothing) takes the new one's; anything typed stays.
   */
  const startFrom = (id: string) => {
    const next = findTemplate(id);
    const untouched = (field: string, from: (t: RoleTemplate) => string) =>
      field.trim() === '' || (template !== null && field === from(template));
    if (untouched(name, (t) => t.name)) setName(next?.name ?? '');
    if (untouched(role, (t) => t.role)) setRole(next?.role ?? '');
    if (untouched(instructions, templateInstructions)) {
      setInstructions(next ? templateInstructions(next) : '');
    }
    if (next) setColor(templateColor(next, takenColors) ?? color);
    setTemplate(next);
  };
  const engines = useAgentsSelector((s) => s.engines);
  const defaults = useAgentsSelector((s) => s.defaults);
  // Until someone picks, a new agent goes where Settings → Agents says new
  // agents start (or, before the overview says, the first engine that can
  // take it), on the model chosen there for that engine. Worked out as the
  // overview arrives rather than once.
  const [picked, setEngine] = useState<AgentEngine | null>(agent?.engine ?? null);
  const engine = picked ?? newAgentEngine(defaults, engines);
  const [pickedModel, setModel] = useState<string | null>(agent ? (agent.model ?? '') : null);
  const model = pickedModel ?? newAgentModel(defaults, engine, modelChoices(engine, engines));
  const switching = Boolean(agent && agent.engine !== engine);
  const [project, setProject] = useState(agent?.project ?? '');
  const [workDirectly, setWorkDirectly] = useState(agent?.workDirectly ?? false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) return;
    let live = true;
    getAgentInstructions(agent.id)
      .then((text) => {
        if (live) setInstructions(text);
      })
      .catch(() => undefined);
    getAgentUsage(agent.id)
      .then((summary) => {
        if (live) setUsage(summary);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agent]);

  // Moving an agent with an open copy to another project would strand the
  // copy's work: Save asks first (Keep / Discard / Cancel), as the backend
  // refuses it otherwise.
  const [rebinding, setRebinding] = useState(false);
  const copySettled = useRef(false);
  const openCopy = agent?.copy;

  const save = useAsyncState(async () => {
    setError(null);
    // Read at call time: Keep / Discard below saves straight after settling.
    if (agent?.copy && !copySettled.current && (project || '') !== (agent.project ?? '')) {
      setRebinding(true);
      return;
    }
    try {
      if (agent) {
        await updateAgent(agent.id, {
          name,
          color,
          ...(lookChanged ? { avatar: look } : {}),
          role,
          instructions,
          engine,
          model,
          project,
          workDirectly,
        });
        onSaved(agent.id);
      } else {
        const created = await createAgent({
          name,
          color,
          avatar: look,
          role,
          instructions,
          engine,
          model,
          project,
          ...(template ? { template: template.id } : {}),
        });
        if (project && workDirectly) await updateAgent(created.id, { workDirectly });
        onSaved(created.id);
      }
      onClose();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  });

  const settle = useAsyncState(async (how: 'keep' | 'discard') => {
    if (!agent || !openCopy) return;
    setError(null);
    try {
      if (how === 'discard') {
        await discardCopy(agent.id, openCopy.id);
      } else {
        const kept = await keepCopy(agent.id, openCopy.id);
        if (kept.outcome !== 'kept' && kept.outcome !== 'nothing') {
          setError(
            `${agent.name}'s changes can't be kept from here yet. Finish keeping them in the chat, then change its project.`
          );
          setRebinding(false);
          return;
        }
      }
      copySettled.current = true;
      setRebinding(false);
      await save.execute();
    } catch (err) {
      setError(formatCommandError(asCommandError(err)));
    }
  });

  const canSave = name.trim().length > 0 && !save.isLoading && !settle.isLoading;
  const copyProject = openCopy ? folderName(openCopy.project) : '';
  const destination = project ? folderName(project) : 'no project';

  const form = (
    <form
      className="agent-editor__body"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save.execute();
      }}
      // ⌘Enter saves from anywhere in it, the instructions included (as comments do).
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        e.currentTarget.requestSubmit();
      }}
    >
      {!editing && (
        <div className="agent-editor__label" role="group" aria-label="Start from">
          Start from
          <SegmentedControl
            value={template?.id ?? ''}
            options={[
              { value: '', label: 'Blank' },
              ...ROLE_TEMPLATES.map((t) => ({ value: t.id, label: t.name, title: t.title })),
            ]}
            onValueChange={startFrom}
            aria-label="Start from"
            className="agent-editor__templates"
          />
          {template && needsLine(template, engine) && (
            <div className="agent-editor__apps agent-editor__needs">
              <p className="agent-editor__hint">{needsLine(template, engine)}</p>
              {engine === 'claude' && onOpenApps && (
                <Button variant="secondary" size="compact" onClick={onOpenApps}>
                  Connect an app…
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="agent-editor__identity">
        {/* The avatar opens its own picker: shape, face and colour. */}
        <button
          type="button"
          className="agent-editor__look-toggle"
          aria-label="Change how it looks"
          title="Change how it looks"
          aria-expanded={showLook}
          onClick={() => setShowLook((open) => !open)}
        >
          <AgentAvatar name={name} color={color} look={look} size="field" />
        </button>
        <TextField
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Agent name"
          maxLength={40}
          autoFocus
        />
      </div>
      {showLook && (
        <AgentLookPicker
          name={name}
          color={color}
          look={look}
          onLookChange={setLook}
          onColorChange={setColor}
        />
      )}

      <label className="agent-editor__label">
        What should it do?
        <TextField
          placeholder="Keeps my inbox down to what matters"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={agent?.isMain}
        />
      </label>
      <label className="agent-editor__label">
        What should it know?
        <TextArea
          rows={editing ? 6 : 4}
          placeholder="Brief it like a new hire: context, standing rules, who's who, where things live."
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      {editing ? (
        <p className="agent-editor__hint">
          What it remembers is kept separately, under Memory, and isn't changed here.
        </p>
      ) : (
        onAskChief && (
          <p className="agent-editor__hint agent-editor__ask-chief">
            Not sure what to write?{' '}
            <TextButton tabIndex={0} variant="primary" onClick={onAskChief}>
              Ask your Chief of Staff to set it up
            </TextButton>
          </p>
        )
      )}

      {/* Out of Advanced: it shows only a choice (two engines installed) or why
          the engine it would use can't run yet, and neither may be hidden. */}
      <AgentEngineField
        engines={engines}
        value={engine}
        current={agent?.engine}
        onChange={(next) => {
          setEngine(next);
          // Models don't cross engines: an agent being made takes the new
          // engine's default model, one that exists goes to its engine's own.
          setModel(agent ? (next === agent.engine ? (agent.model ?? '') : '') : null);
        }}
        onSetUp={onSetUpEngine}
        note={
          switching &&
          `Its next message starts fresh on ${ENGINE_LABEL[engine]}, handed the recent conversation. Instructions and memory carry over.`
        }
      />

      <div className="agent-editor__advanced">
        <TextButton
          className="agent-editor__more"
          aria-expanded={showAdvanced}
          leftIcon={
            <ChevronRightIcon
              size={10}
              className="agent-editor__more-chevron"
              data-open={showAdvanced || undefined}
            />
          }
          onClick={() => setShowAdvanced((open) => !open)}
        >
          Advanced
        </TextButton>
        {showAdvanced && (
          <div className="agent-editor__advanced-body">
            <div className="agent-editor__label" role="group" aria-label="Model">
              Model
              <SegmentedControl
                value={model}
                options={modelChoices(engine, engines)}
                onValueChange={setModel}
                aria-label="Model"
              />
              {/* The engine's own name for it, small: what you'd tell someone who asks. */}
              {modelChoices(engine, engines).find((m) => m.value === model)?.detail && (
                <span className="agent-editor__model-detail">
                  Uses {modelChoices(engine, engines).find((m) => m.value === model)?.detail}
                </span>
              )}
            </div>

            <AgentProjectField
              value={project}
              onChange={setProject}
              direct={workDirectly}
              onDirectChange={setWorkDirectly}
            />

            {onOpenApps && (
              <div
                className="agent-editor__label"
                role="group"
                aria-label="Apps this agent can use"
              >
                Apps this agent can use
                <div className="agent-editor__apps">
                  <p className="agent-editor__hint">
                    {engine === 'codex'
                      ? 'This agent can use the apps you’ve connected in Codex.'
                      : 'This agent can use the apps you’ve connected.'}
                  </p>
                  {engine === 'claude' && (
                    <Button variant="secondary" size="compact" onClick={onOpenApps}>
                      Manage apps…
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {agent && (
        <div className="agent-editor__briefing">
          <UsageLines usage={usage} agent={agent} />
          <CanDo agent={agent} />
          <AdminSwitch agent={agent} />
          <Permissions agent={agent} />
          <AgentPolicy agent={agent} onAskInChat={onAskInChat} />
          <AgentReach agent={agent} />
        </div>
      )}
      {/* With one engine there's no "Runs on": what protects it, and the way to add another, live down here. */}
      <AgentEngineMore engines={engines} value={engine} onSetUp={onSetUpEngine} />

      {error && (
        <p className="agent-editor__error" role="alert">
          <ErrorIcon size={12} className="inline-error-icon" />
          {error}
        </p>
      )}

      {rebinding && agent && openCopy && (
        <div className="agent-editor__rebind" role="alert">
          <p>
            {agent.name} has a copy of {copyProject} open with changes that haven&apos;t been kept.
            Keep them in {copyProject}
            {openCopy.baseBranch ? ` (${openCopy.baseBranch})` : ''} or discard them before it moves
            to {destination}.
          </p>
          <div className="agent-editor__rebind-actions">
            <Button
              variant="strong"
              size="compact"
              data-allow
              disabled={settle.isLoading}
              onClick={() => void settle.execute('keep')}
            >
              Keep changes
            </Button>
            <Button
              variant="danger"
              size="compact"
              disabled={settle.isLoading}
              onClick={() => void settle.execute('discard')}
            >
              Discard
            </Button>
            <Button
              variant="secondary"
              size="compact"
              disabled={settle.isLoading}
              onClick={() => setRebinding(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="agent-editor__actions">
        {editing && agent && !agent.isMain && onDelete && (
          <Button variant="danger" className="agent-editor__delete" onClick={() => onDelete(agent)}>
            Delete
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!canSave}>
          {editing ? 'Save' : 'Create'}
        </Button>
      </div>
    </form>
  );

  // The modal is portalled out of the chat, so it is scoped here — to the
  // colour being picked, which makes Save preview it.
  return (
    <AccentScope color={color}>
      <ModalFrame
        isOpen={isOpen}
        onClose={onClose}
        title={editing ? `Edit ${agent?.name}` : 'New agent'}
        className="agent-editor"
      >
        {agent ? (
          <Tabs value={tab} onValueChange={(v) => setTab(v as EditorTab)}>
            <TabsList className="agent-editor__tabs" aria-label="Edit">
              <TabsTab value="agent" width="fill">
                Agent
              </TabsTab>
              <TabsTab value="memory" width="fill">
                Memory
              </TabsTab>
            </TabsList>
            <TabsPanel value="agent">{form}</TabsPanel>
            <TabsPanel value="memory">
              {tab === 'memory' && <AgentMemory agent={agent} />}
            </TabsPanel>
          </Tabs>
        ) : (
          form
        )}
      </ModalFrame>
    </AccentScope>
  );
}
