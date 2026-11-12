/**
 * Create a new agent, or edit one, as one sheet in the Settings kit: its bar
 * (Cancel · title · Done), a contact card (its key big, its name, "Change
 * look · on Claude Code · Steady"), then grouped rows. Editing has three
 * tabs, Agent, Memory and Usage. Rows that hold more than a value
 * (Independence, Beyond its level, Apps and access, Skills, Project) open
 * their page in place, with "‹ Edit agent" to come back; nothing hides under
 * an "Advanced". Switches and lists apply as they change; the words (name,
 * its line, what it should know) and its engine, model and project save on
 * Done.
 *
 * Creating opens on "Describe the agent you want" (`AgentDescribe`): a few
 * sentences and Draft it fill every row, plus the routines to keep, for one
 * review before Create. Or "Start from": blank, or a ready-made agent
 * (`lib/agentTemplates`) that fills the rows with its briefing.
 *
 * @module components/agents/AgentEditorModal
 */

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ErrorIcon } from '@/components/icons';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../primitives/Tabs';
import { AgentProjectField } from './AgentProject';
import { AgentMemory } from './AgentMemory';
import { AgentKey } from './AgentKey';
import { AgentKeyPicker } from './AgentKeyPicker';
import {
  boundKeyFor,
  colorwayForColor,
  freshColorway,
  iconFor,
  keyLookFor,
  legacyColorFor,
} from '../../../packages/companion-protocol/src/agentKeys';
import { AgentReach } from './AgentReach';
import { AgentPolicy } from './AgentPolicy';
import { AgentLevelPicker } from './AgentLevelPicker';
import { AgentEngineProtections, engineReason, showsEnginePicker } from './AgentEngine';
import { Group, Row } from './AgentSettingsRows';
import {
  CanDo,
  DeleteRow,
  FieldRow,
  MenuRow,
  NavRow,
  Permissions,
  SheetBar,
  SheetCard,
  UsagePage,
} from './AgentEditorParts';
import {
  type AgentEngine,
  createAgent,
  discardCopy,
  ENGINE_LABEL,
  engineUnavailable,
  folderName,
  keepCopy,
  newAgentEngine,
  newAgentModel,
  getAgentInstructions,
  getAgentUsage,
  keptRoutines,
  openingOf,
  modelChoices,
  updateAgent,
  type Agent,
  type AgentDraft,
  type UsageSummary,
} from '../../lib/agents';
import { INDEPENDENCE_SHORT, effectiveIndependence } from '../../lib/agentIndependence';
import { agentReach } from '../../lib/agentLogins';
import { agentSkills } from '../../lib/agentSkills';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { getAgentsSnapshot, useAgentsSelector } from '../../lib/agentsStore';
import { useAsyncState } from '../../hooks/useAsyncState';
import { AccentScope } from '../../contexts/AccentScopeContext';
import { AdminRow } from './AgentAdmin';
import { ADMIN_DETAIL } from '../../lib/agentAdmin';
import { AgentSkills } from './AgentSkills';
import {
  findTemplate,
  needsLine,
  ROLE_TEMPLATES,
  templateInstructions,
  type RoleTemplate,
} from '../../lib/agentTemplates';
import { AgentDescribe, AgentDrafted, AgentDraftRoutines } from './AgentDescribe';

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
  /** Editing: open on its memory or usage rather than its settings. */
  initialTab?: EditorTab;
  /** Editing: open this page in place ("Skills", "What it can reach"). */
  initialFocus?: 'skills' | 'reach';
  /** Install or sign in to an engine that isn't ready, over the editor. */
  onSetUpEngine?: (engine: AgentEngine, step: 'install' | 'sign-in') => void;
  /** Creating: close and draft the request in the Chief of Staff's chat instead. */
  onAskChief?: () => void;
  /** "Change in chat": close and draft a settings request in the Chief of Staff's chat. */
  onAskInChat?: (text: string) => void;
  /** Creating: open on this ready-made agent (an id from `ROLE_TEMPLATES`). */
  initialTemplate?: string | null;
}

export type EditorTab = 'agent' | 'memory' | 'usage';

/** A page that opened in place, over the sheet's rows. */
type Page = 'independence' | 'beyond' | 'access' | 'skills' | 'project';

const PAGE_TITLE: Record<Page, string> = {
  independence: 'Independence',
  beyond: 'Beyond its level',
  access: 'Apps and access',
  skills: 'Skills',
  project: 'Project',
};

/** "Slack, GitHub +2": the apps it holds, as a row's value. */
function appsValue(titles: string[]): string {
  if (titles.length === 0) return 'None yet';
  const shown = titles.slice(0, 2).join(', ');
  return titles.length > 2 ? `${shown} +${titles.length - 2}` : shown;
}

/** A template's own colour, unless another agent already wears it. */
function templateColor(template: RoleTemplate | null, taken: string[] = []): string | null {
  return template && !taken.includes(template.color) ? template.color : null;
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
  initialFocus,
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
  // Its key (docs/design/agent-keys.md). Editing: what it wears now.
  // Creating: a template's colour, else the colourway fewest wear; a legend
  // read from its name and role and the first free letter of its name, both
  // following what's typed until one is picked. The old colour field (and
  // the accent, for the Chief) follows the colourway.
  const others = useMemo(
    () => getAgentsSnapshot().agents.filter((a) => a.id !== agent?.id),
    [agent?.id]
  );
  const saved = agent ? keyLookFor(agent) : null;
  const [colorway, setColorwayState] = useState<string>(() => {
    if (saved) return saved.colorway;
    const fromTemplate = templateColor(first, takenColors);
    return fromTemplate
      ? colorwayForColor(fromTemplate)
      : freshColorway(others.map((a) => keyLookFor(a).colorway));
  });
  const [color, setColor] = useState<string>(
    () => agent?.color ?? templateColor(first, takenColors) ?? legacyColorFor(colorway)
  );
  const setColorway = (c: string) => {
    setColorwayState(c);
    setColor(legacyColorFor(c));
  };
  const [pickedIcon, setIcon] = useState<string | null>(saved?.icon ?? null);
  const [pickedKey, setBoundKey] = useState<string | null>(saved?.boundKey ?? null);
  // Folded to the key in the contact card, which opens it.
  const [showLook, setShowLook] = useState(false);
  // Opened by hand (not a new agent's, open from the start): its icon search takes focus.
  const [lookByHand, setLookByHand] = useState(false);
  const [role, setRole] = useState(agent?.role ?? first?.role ?? '');
  const icon = pickedIcon ?? iconFor(name, role);
  const taken = useMemo(
    () =>
      others.flatMap((a) => {
        const k = keyLookFor(a).boundKey;
        return k ? [{ key: k, name: a.name }] : [];
      }),
    [others]
  );
  const boundKey =
    pickedKey ??
    boundKeyFor(
      name,
      taken.map((t) => t.key)
    );
  const keyChanged = {
    ...(colorway !== saved?.colorway ? { colorway } : {}),
    ...(icon !== saved?.icon ? { icon } : {}),
    ...(boundKey && boundKey !== saved?.boundKey ? { boundKey } : {}),
  };
  const [instructions, setInstructions] = useState(first ? templateInstructions(first) : '');
  // "Describe the agent you want": what came back, and which routines stay ticked.
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [kept, setKept] = useState<boolean[]>([]);
  const takeDraft = (d: AgentDraft) => {
    setDraft(d);
    setTemplate(null);
    setName(d.name);
    setRole(d.role);
    setInstructions(d.instructions);
    if (!(takenColors ?? []).includes(d.color)) {
      setColorwayState(colorwayForColor(d.color));
      setColor(d.color);
    }
    setKept(d.routines.map((r) => !r.problem));
    // The review is what matters now: its key folds to the avatar beside
    // the name (one click opens it), so the briefing and routines aren't
    // pushed below a picker of two thousand icons.
    setShowLook(false);
  };
  const startOver = () => {
    setDraft(null);
    setKept([]);
    setName('');
    setRole('');
    setInstructions('');
  };

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
    const nextColor = next ? templateColor(next, takenColors) : null;
    if (nextColor) {
      setColorwayState(colorwayForColor(nextColor));
      setColor(nextColor);
    }
    setTemplate(next);
  };
  const engines = useAgentsSelector((s) => s.engines);
  const teamLevel = useAgentsSelector((s) => s.independence);
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
  // New agent opens on "Describe the agent you want" alone; the form shows
  // once there's a draft, a template, or "fill it in yourself". Editing (or
  // opening on a template) starts on the form. While describing, the form's
  // fields are hidden by the stylesheet (`[data-describing]`), not unmounted.
  const [manual, setManual] = useState(editing || Boolean(first));
  const describing = !editing && !draft && !manual;
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
          ...keyChanged,
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
          colorway,
          icon,
          ...(boundKey ? { boundKey } : {}),
          role,
          instructions,
          engine,
          model,
          project,
          ...(template ? { template: template.id } : {}),
          ...(draft ? { routines: keptRoutines(draft, kept), ...openingOf(draft) } : {}),
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
  const submit = () => {
    if (canSave) void save.execute();
  };

  // A page that opened in place; Skills and "What it can reach" can be asked for on opening.
  const [page, setPage] = useState<Page | null>(
    agent && initialFocus ? (initialFocus === 'skills' ? 'skills' : 'access') : null
  );
  const live = useAgentsSelector((s) => s.agents?.find((a) => a.id === agent?.id)) ?? agent;
  // The values its rows show: read once per open, and again on coming back from a page.
  const [apps, setApps] = useState<string[] | null>(null);
  const [skillCount, setSkillCount] = useState<number | null>(null);
  useEffect(() => {
    if (!agent || page) return;
    let on = true;
    agentReach(agent.id)
      .then((r) => on && setApps(r.connections.map((c) => c.title)))
      .catch(() => undefined);
    agentSkills(agent.id)
      .then((v) => on && setSkillCount(v.skills.length))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [agent, page]);

  // Engine: a menu once two can run, else what it's on; why one can't run, never hidden.
  const picker = showsEnginePicker(engines);
  const shownEngines = engines.filter(
    (e) => e.installed || e.id === engine || e.id === agent?.engine
  );
  const blocked = (picker ? shownEngines : shownEngines.filter((e) => e.id === engine)).flatMap(
    (info) => {
      const need = engineUnavailable(info);
      return need ? [{ info, need }] : [];
    }
  );
  const addable = picker ? [] : engines.filter((e) => !e.installed && e.id !== engine);
  const models = modelChoices(engine, engines);
  const pickEngine = (next: AgentEngine) => {
    setEngine(next);
    // Models don't cross engines: an agent being made takes the new
    // engine's default model, one that exists goes to its engine's own.
    setModel(agent ? (next === agent.engine ? (agent.model ?? '') : '') : null);
  };
  const runsOnNote = (
    <>
      {switching && (
        <span className="agent-sheet__note">
          Its next message starts fresh on {ENGINE_LABEL[engine]}, handed the recent conversation.
          Instructions and memory carry over.
        </span>
      )}
      {blocked.map(({ info, need }) => (
        <span key={info.id} className="agent-sheet__note">
          {engineReason(info, need)}{' '}
          {onSetUpEngine && (
            <TextButton tabIndex={0} onClick={() => onSetUpEngine(info.id, need)}>
              {need === 'install' ? `Set up ${info.label}` : `Sign in to ${info.label}`}
            </TextButton>
          )}
        </span>
      ))}
      {onSetUpEngine &&
        addable.map((info) => (
          <span key={info.id} className="agent-sheet__note">
            <TextButton tabIndex={0} onClick={() => onSetUpEngine(info.id, 'install')}>
              Also use {info.label}
            </TextButton>
          </span>
        ))}
    </>
  );
  const hasRunsOnNote = switching || blocked.length > 0 || addable.length > 0;

  const level = effectiveIndependence({ independence: live?.independence ?? null }, teamLevel);
  const levelValue = `${INDEPENDENCE_SHORT[level]}${live?.independence ? '' : ' · same as team'}`;
  const ruleCount = live?.permissions?.length ?? 0;

  // Enter in a row's field and ⌘Enter anywhere (the instructions included) save.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const inField = (e.target as HTMLElement).classList.contains('agent-sheet__field');
    if (!(e.metaKey || e.ctrlKey) && !inField) return;
    e.preventDefault();
    submit();
  };

  const contactCard = (
    <div className="agent-sheet__contact">
      {/* The key opens its own picker: shape, face and colour. */}
      <button
        type="button"
        className="agent-sheet__key"
        aria-label={showLook ? 'Done changing how it looks' : 'Change how it looks'}
        title={showLook ? 'Done changing how it looks' : 'Change how it looks'}
        aria-expanded={showLook}
        onClick={() => {
          setLookByHand(true);
          setShowLook((open) => !open);
        }}
      >
        <AgentKey name={name || 'New agent'} colorway={colorway} icon={icon} size="xl" />
      </button>
      <p className="agent-sheet__name">{name.trim() || (editing ? agent?.name : 'New agent')}</p>
      <p className="agent-sheet__meta">
        <TextButton
          tabIndex={0}
          className="agent-sheet__look"
          aria-expanded={showLook}
          onClick={() => {
            setLookByHand(true);
            setShowLook((open) => !open);
          }}
        >
          {showLook ? 'Done with its look' : 'Change look'}
        </TextButton>
        {engines.length > 0 && <span> · on {ENGINE_LABEL[engine]}</span>}
        {live && <span> · {INDEPENDENCE_SHORT[level]}</span>}
      </p>
      {showLook && (
        <SheetCard>
          <AgentKeyPicker
            name={name}
            colorway={colorway}
            icon={icon}
            boundKey={boundKey}
            level={agent?.independence ?? teamLevel}
            taken={taken}
            onColorwayChange={setColorway}
            onIconChange={setIcon}
            onBoundKeyChange={setBoundKey}
            autoFocusSearch={lookByHand}
          />
        </SheetCard>
      )}
    </div>
  );

  const startFromCard = !editing && !draft && manual && (
    <Group
      id="agent-start"
      title="Start from"
      footnote={
        <>
          {template && needsLine(template, engine) && (
            <span className="agent-sheet__note">
              {needsLine(template, engine)}{' '}
              {engine === 'claude' && onOpenApps && (
                <TextButton tabIndex={0} onClick={onOpenApps}>
                  Connect an app…
                </TextButton>
              )}
            </span>
          )}
          {/* The way back to the one box (what's typed here stays, for a draft to replace). */}
          <TextButton
            tabIndex={0}
            className="agent-editor__describe"
            onClick={() => setManual(false)}
          >
            Or describe it instead
          </TextButton>
        </>
      }
    >
      <div className="agent-sheet__segmented">
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
      </div>
    </Group>
  );

  const rows = (
    <div className="agent-sheet__groups">
      <Group id="agent-what" title="What it does">
        <FieldRow
          label="Name"
          ariaLabel="Agent name"
          value={name}
          onChange={setName}
          placeholder="Name it"
          maxLength={40}
          autoFocus={editing || !!first}
        />
        <FieldRow
          label="In one line"
          ariaLabel="What should it do?"
          value={role}
          onChange={setRole}
          placeholder="Keeps my inbox down to what matters"
          disabled={agent?.isMain}
        />
      </Group>

      <Group
        id="agent-know"
        title="What it should know"
        footnote={
          editing ? (
            'Its memory is under Memory and isn’t changed here.'
          ) : onAskChief && !draft ? (
            <>
              Not sure what to write?{' '}
              <TextButton tabIndex={0} onClick={onAskChief}>
                Ask your Chief of Staff to set it up
              </TextButton>
            </>
          ) : undefined
        }
      >
        <textarea
          className="agent-sheet__textarea"
          rows={5}
          aria-label="What should it know?"
          placeholder="Brief it like a new hire: context, standing rules, who's who, where things live."
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </Group>

      {!editing && draft && (
        <AgentDraftRoutines
          draft={draft}
          kept={kept}
          onKept={(i, on) => setKept((k) => k.map((v, j) => (j === i ? on : v)))}
        />
      )}

      {engines.length > 0 && (
        <Group
          id="agent-runs-on"
          title="How it runs"
          footnote={hasRunsOnNote ? runsOnNote : undefined}
        >
          {picker ? (
            <MenuRow
              label="Runs on"
              value={engine}
              choices={shownEngines.map((info) => ({
                value: info.id,
                label: info.label,
                disabled: info.id !== agent?.engine && Boolean(engineUnavailable(info)),
              }))}
              onChange={pickEngine}
            />
          ) : (
            <Row label="Runs on">
              <span className="agent-sheet__value">{ENGINE_LABEL[engine]}</span>
            </Row>
          )}
          {models.length > 1 ? (
            <MenuRow label="Model" value={model} choices={models} onChange={setModel} />
          ) : (
            <Row label="Model">
              <span className="agent-sheet__value">Default</span>
            </Row>
          )}
          <NavRow
            label="Project"
            value={project ? folderName(project) : 'None'}
            onOpen={() => setPage('project')}
          />
        </Group>
      )}

      {live && (
        <Group id="agent-own" title="On its own" footnote={ADMIN_DETAIL}>
          <NavRow label="Independence" value={levelValue} onOpen={() => setPage('independence')} />
          <NavRow
            label="Beyond its level"
            value={
              ruleCount === 0 ? 'Nothing' : ruleCount === 1 ? '1 thing' : `${ruleCount} things`
            }
            onOpen={() => setPage('beyond')}
          />
          <AdminRow agent={live} />
        </Group>
      )}

      {live && (
        <Group
          id="agent-use"
          title="What it can use"
          footnote="Independence, admin, apps and skills change at once. Everything else saves on Done."
        >
          <NavRow
            label="Apps and access"
            value={apps === null ? undefined : appsValue(apps)}
            onOpen={() => setPage('access')}
          />
          <NavRow
            label="Skills"
            value={
              skillCount === null ? undefined : skillCount === 0 ? 'None yet' : String(skillCount)
            }
            onOpen={() => setPage('skills')}
          />
        </Group>
      )}

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

      {editing && agent && !agent.isMain && onDelete && (
        <DeleteRow label="Delete agent" onDelete={() => onDelete(agent)} />
      )}
    </div>
  );

  const describe = !editing && (
    <>
      {draft ? (
        <AgentDrafted onStartOver={startOver} />
      ) : (
        !manual && <AgentDescribe autoFocus={!first} onDrafted={(d) => takeDraft(d)} />
      )}
      {describing && (
        // The other ways in, quiet: describing is the one this sheet leads with.
        <p className="agent-editor__hint agent-editor__other-ways">
          Or{' '}
          <TextButton
            tabIndex={0}
            className="agent-editor__fill-in"
            onClick={() => setManual(true)}
          >
            fill it in yourself
          </TextButton>
          , start from{' '}
          {ROLE_TEMPLATES.map((t, i) => (
            <Fragment key={t.id}>
              {i > 0 && (i === ROLE_TEMPLATES.length - 1 ? ' or ' : ', ')}
              <TextButton
                tabIndex={0}
                title={t.title}
                onClick={() => {
                  startFrom(t.id);
                  setManual(true);
                }}
              >
                {t.name}
              </TextButton>
            </Fragment>
          ))}
          {onAskChief && (
            <>
              , or{' '}
              <TextButton tabIndex={0} onClick={onAskChief}>
                ask your Chief of Staff
              </TextButton>
            </>
          )}
          .
        </p>
      )}
    </>
  );

  const answer = !describing && (
    <Button variant="strong" size="compact" disabled={!canSave} onClick={submit}>
      {editing ? 'Done' : 'Create'}
    </Button>
  );

  const pageBody = live && page && (
    <div className="agent-sheet__groups">
      {page === 'independence' && (
        <>
          <SheetCard>
            <AgentLevelPicker agent={live} />
          </SheetCard>
          <div className="settings-group__footnote agent-sheet__card-note">
            <AgentEngineProtections engines={engines} value={engine} />
          </div>
        </>
      )}
      {page === 'beyond' && <Permissions agent={live} />}
      {page === 'access' && (
        <>
          <SheetCard>
            <AgentPolicy agent={live} onAskInChat={onAskInChat} />
            <AgentReach agent={live} onOpenApps={onOpenApps} />
          </SheetCard>
          <CanDo agent={live} />
          {onOpenApps && engine === 'claude' && (
            <Group id="agent-apps" title="Apps you’ve connected">
              <NavRow label="Manage apps" onOpen={onOpenApps} />
            </Group>
          )}
        </>
      )}
      {page === 'skills' && (
        <SheetCard>
          <AgentSkills agent={live} />
        </SheetCard>
      )}
      {page === 'project' && (
        <SheetCard>
          <AgentProjectField
            value={project}
            onChange={setProject}
            direct={workDirectly}
            onDirectChange={setWorkDirectly}
          />
        </SheetCard>
      )}
    </div>
  );

  // The project page is the one a new agent has too (no agent yet, no `live`).
  const projectOnly = !live && page === 'project' && (
    <div className="agent-sheet__groups">
      <SheetCard>
        <AgentProjectField
          value={project}
          onChange={setProject}
          direct={workDirectly}
          onDirectChange={setWorkDirectly}
        />
      </SheetCard>
    </div>
  );

  const title = editing ? 'Edit agent' : 'New agent';
  const sheet = page ? (
    <div className="agent-sheet" data-page={page}>
      <SheetBar title={PAGE_TITLE[page]} onBack={() => setPage(null)} backLabel={title} />
      <div className="agent-sheet__scroll">{pageBody || projectOnly}</div>
    </div>
  ) : (
    <div className="agent-sheet" onKeyDown={onKeyDown}>
      <SheetBar title={title} onCancel={onClose} done={answer} />
      <div className="agent-sheet__scroll" data-describing={describing || undefined}>
        {describe}
        {!describing && startFromCard && <div className="agent-sheet__start">{startFromCard}</div>}
        {!describing && contactCard}
        {agent ? (
          <Tabs value={tab} onValueChange={(v) => setTab(v as EditorTab)}>
            <TabsList className="agent-sheet__tabs" aria-label="Edit">
              <TabsTab value="agent" width="fill">
                Agent
              </TabsTab>
              <TabsTab value="memory" width="fill">
                Memory
              </TabsTab>
              <TabsTab value="usage" width="fill">
                Usage
              </TabsTab>
            </TabsList>
            <TabsPanel value="agent">{rows}</TabsPanel>
            <TabsPanel value="memory">
              {tab === 'memory' && (
                <SheetCard>
                  <AgentMemory agent={agent} />
                </SheetCard>
              )}
            </TabsPanel>
            <TabsPanel value="usage">
              {tab === 'usage' && <UsagePage usage={usage} agent={live ?? agent} />}
            </TabsPanel>
          </Tabs>
        ) : (
          // Mounted while describing too: Runs on stays (the draft is made
          // on it); the rest waits out of sight and out of the Tab order.
          rows
        )}
      </div>
    </div>
  );

  // The modal is portalled out of the chat, so it is scoped here — to the
  // colour being picked, which makes Done preview it.
  return (
    <AccentScope color={color}>
      <ModalFrame
        isOpen={isOpen}
        onClose={onClose}
        ariaLabel={editing ? `Edit ${agent?.name}` : 'New agent'}
        showCloseButton={false}
        className="agent-editor agent-editor--sheet"
      >
        {sheet}
      </ModalFrame>
    </AccentScope>
  );
}
