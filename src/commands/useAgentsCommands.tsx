/**
 * Palette commands for Agents. Registered app-wide, so "New agent…" and
 * "Open Finance" work from anywhere: they switch to Agents mode and act there.
 *
 * @module commands/useAgentsCommands
 */

import { keyLookFor } from '../../packages/companion-protocol/src/agentKeys';
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  AgentsIcon,
  CollaboratorsIcon,
  CommentIcon,
  DownloadIcon,
  FileTextIcon,
  GlobeIcon,
  PlugIcon,
  PlusIcon,
  RoutineIcon,
  SearchIcon,
  ZapIcon,
} from '@/components/icons';
import { useCommands } from './useCommands';
import { kbd } from '../lib/shortcuts';
import { onMenuAction } from '../lib/nativeMenu';
import { useOptionalToast } from '../contexts/ToastContext';
import { setStayOn, type StayOnChange } from '../lib/remoteAccess';
import { useAgentsSelector, type AgentsState } from '../lib/agentsStore';
import type { AppView } from '../lib/types';
import { AGENT_EVENTS, OTHER_APP_NAME, otherAppExists, TEAM_ID } from '../lib/agents';
import { DESCRIBE_START, ROLE_TEMPLATES } from '../lib/agentTemplates';
import { SHARE_RECIPE_EVENT } from '../lib/agentRecipe';
import { openLogs } from '../lib/agentDesk';
import { composerDraft, setComposerDraft } from '../lib/composerDraft';
import {
  setGroupMode,
  setSortMode,
  startNamingGroup,
  useAgentGroups,
  type GroupMode,
} from '../lib/agentGroups';
import { asCommandError, formatCommandError } from '../lib/errors';

/** What went wrong, in words: never `String(e)`'s "Error: …" or "[object Object]". */
const errorText = (e: unknown) => formatCommandError(asCommandError(e));

/** ⌘K switches for the agent list's optional groups. */
const GROUP_COMMANDS: { mode: GroupMode; title: string; keywords: string[] }[] = [
  { mode: 'project', title: 'Group agents by project', keywords: ['client', 'bound', 'folder'] },
  { mode: 'custom', title: 'Group agents into your own groups', keywords: ['client', 'folder'] },
  { mode: 'off', title: 'Stop grouping agents', keywords: ['flat', 'ungroup', 'one list'] },
];
import {
  checkTeamReach,
  resumeTeamSetup,
  SETUP_TITLE,
  useResumableTeamSetup,
} from '../lib/teamSetup';
import { THIS_COMPUTER, THIS_COMPUTER_CAP } from '../lib/computer';

type AgentsIntent =
  | { kind: 'new'; template?: string }
  | { kind: 'import'; from?: 'otherApp' | 'paste' }
  | { kind: 'apps' }
  | { kind: 'search' }
  | { kind: 'ideas' }
  | { kind: 'logins' }
  | { kind: 'browser' }
  | { kind: 'recipe'; agentId: string }
  | { kind: 'routines'; ask?: 'pause' | 'resume' }
  | { kind: 'open'; agentId: string };
let pendingIntent: AgentsIntent | null = null;
const intentListeners = new Set<(intent: AgentsIntent) => void>();

/** Ask Agents mode to do something, now if it's mounted or as soon as it is. */
export function requestAgentsIntent(intent: AgentsIntent) {
  if (intentListeners.size > 0) {
    intentListeners.forEach((listener) => listener(intent));
  } else {
    pendingIntent = intent;
  }
}

/** Agents mode consumes intents with this. */
export function useAgentsIntents(handlers: {
  /** `template`: open on that ready-made agent. */
  onNewAgent: (template?: string) => void;
  /** `otherApp`: open on the other app's team when it's on this Mac; `paste`: on an export or a pasted reply. */
  onImportAgents: (from?: 'otherApp' | 'paste') => void;
  onApps: () => void;
  onOpenAgent: (agentId: string) => void;
  onSearch: () => void;
  /** The gallery of things to ask the Chief. */
  onIdeas: () => void;
  /** "What your team needs": every login waiting, one row per app. */
  onLogins?: () => void;
  /** "Let agents use your browser": the guided card. */
  onBrowser?: () => void;
  /** Share an agent as a recipe (the Chief's `share_recipe`). */
  onShareRecipe?: (agentId: string) => void;
  /** Routines, every agent's; `ask`: open on "Pause all" / "Resume all". */
  onRoutines?: (ask?: 'pause' | 'resume') => void;
}) {
  const {
    onNewAgent,
    onImportAgents,
    onApps,
    onOpenAgent,
    onSearch,
    onIdeas,
    onLogins,
    onBrowser,
    onShareRecipe,
    onRoutines,
  } = handlers;
  useEffect(() => {
    const listener = (intent: AgentsIntent) => {
      if (intent.kind === 'new') onNewAgent(intent.template);
      else if (intent.kind === 'import') onImportAgents(intent.from);
      else if (intent.kind === 'apps') onApps();
      else if (intent.kind === 'search') onSearch();
      else if (intent.kind === 'ideas') onIdeas();
      else if (intent.kind === 'logins') onLogins?.();
      else if (intent.kind === 'browser') onBrowser?.();
      else if (intent.kind === 'recipe') onShareRecipe?.(intent.agentId);
      else if (intent.kind === 'routines') onRoutines?.(intent.ask);
      else onOpenAgent(intent.agentId);
    };
    intentListeners.add(listener);
    if (pendingIntent) {
      const intent = pendingIntent;
      pendingIntent = null;
      listener(intent);
    }
    return () => {
      intentListeners.delete(listener);
    };
  }, [
    onNewAgent,
    onImportAgents,
    onApps,
    onOpenAgent,
    onSearch,
    onIdeas,
    onLogins,
    onBrowser,
    onShareRecipe,
    onRoutines,
  ]);
}

/** What the "Open <agent>" commands name: a status or a new message doesn't change them. */
const selectAgents = (s: AgentsState) => s.agents;
const sameNames = (a: AgentsState['agents'], b: AgentsState['agents']) =>
  a.length === b.length &&
  a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.role === b[i].role);

/** ⌘K switches for keeping agents going; the same settings as the first-run note. */
const STAY_ON_COMMANDS: { id: string; title: string; change: StayOnChange; done: string }[] = [
  {
    id: 'awakeOn',
    title: `Keep ${THIS_COMPUTER} awake for agents`,
    change: { keepAwake: true },
    done: `${THIS_COMPUTER_CAP} stays awake while the app is open`,
  },
  {
    id: 'awakeOff',
    title: `Let ${THIS_COMPUTER} sleep again`,
    change: { keepAwake: false },
    done: `${THIS_COMPUTER_CAP} can sleep again; agents pause while it sleeps`,
  },
  {
    id: 'runningOn',
    title: 'Keep agents running when the window closes',
    change: { keepRunning: true },
    done: 'Closing the window keeps agents going; ⌘Q still quits',
  },
  {
    id: 'runningOff',
    title: 'Quit when the window closes',
    change: { keepRunning: false },
    done: 'Closing the window quits the app again',
  },
  {
    id: 'loginOn',
    title: 'Open at login',
    change: { openAtLogin: true },
    done: 'Opens when you log in',
  },
];

export function useAgentsNavCommands({ setView }: { setView: (view: AppView) => void }) {
  const agents = useAgentsSelector(selectAgents, sameNames);
  const { showToast } = useOptionalToast();
  // "Setting up your team", offered while there's one to finish (put away or not).
  const setup = useResumableTeamSetup();
  const chief = agents.find((a) => a.isMain);
  const chiefId = chief?.id;
  const chiefName = chief?.name;
  const groupSettings = useAgentGroups();
  const groupMode = groupSettings.mode;
  const sortMode = groupSettings.sort;
  const hasOwnOrder = groupSettings.order.length > 0;
  // Whether the other app has agents on this Mac, asked once from its
  // registry alone (not the preview, which reads every agent's folder): it
  // gates the palette's "Import agents from …", which only means something then.
  const [otherApp, setOtherApp] = useState(false);
  useEffect(() => {
    let live = true;
    void otherAppExists()
      .then((exists) => live && setOtherApp(exists))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  // A clicked notification (the backend already focused this window): open that agent.
  useEffect(() => {
    const unlisten = listen<string>(AGENT_EVENTS.open, (e) => {
      requestAgentsIntent({ kind: 'open', agentId: e.payload });
      setView('agents');
    });
    return () => void unlisten.then((off) => off());
  }, [setView]);
  // File → New Agent… (⌘N on macOS; Agents' own key handler elsewhere).
  useEffect(
    () =>
      onMenuAction((action) => {
        if (action !== 'new_agent') return;
        if (document.querySelector('[aria-modal="true"]')) return;
        requestAgentsIntent({ kind: 'new' });
        setView('agents');
      }),
    [setView]
  );
  // The Chief's `share_recipe`: that agent's recipe, on the desk.
  useEffect(() => {
    const unlisten = listen<string>(SHARE_RECIPE_EVENT, (e) => {
      requestAgentsIntent({ kind: 'recipe', agentId: e.payload });
      setView('agents');
    });
    return () => void unlisten.then((off) => off());
  }, [setView]);
  // The Chief's `bring_agents_over` with no file: Import, at an export or a paste.
  useEffect(() => {
    const unlisten = listen<string>(AGENT_EVENTS.openImport, () => {
      requestAgentsIntent({ kind: 'import', from: 'paste' });
      setView('agents');
    });
    return () => void unlisten.then((off) => off());
  }, [setView]);

  useCommands(
    () => [
      // ⌘K's way on from "nothing matches": what was typed, put in the
      // Chief's message box (never sent), for it to work out.
      ...(chiefId && chiefName
        ? [
            {
              id: 'agents.askChief',
              title: `Ask ${chiefName}`,
              icon: <CommentIcon size={14} />,
              category: 'action' as const,
              fallback: true,
              run: (query?: string) => {
                const text = query?.trim();
                if (text) {
                  const before = composerDraft(chiefId).trimEnd();
                  setComposerDraft(chiefId, before ? `${before}\n${text}` : text);
                }
                requestAgentsIntent({ kind: 'open', agentId: chiefId });
                setView('agents');
              },
            },
          ]
        : []),
      {
        id: 'agents.open',
        title: 'Agents',
        icon: <AgentsIcon size={14} />,
        category: 'navigation',
        keywords: ['chat', 'chief of staff', 'assistant', 'bots', 'team'],
        run: () => setView('agents'),
      },
      {
        id: 'agents.new',
        title: 'New agent…',
        icon: <PlusIcon size={14} />,
        category: 'navigation',
        shortcut: kbd('mod', 'N'),
        keywords: ['agents', 'create', 'bot'],
        run: () => {
          requestAgentsIntent({ kind: 'new' });
          setView('agents');
        },
      },
      {
        id: 'agents.ideas',
        title: 'Ideas for your team…',
        icon: <ZapIcon size={14} />,
        category: 'navigation',
        keywords: [
          'agents',
          'chief of staff',
          'starters',
          'examples',
          'what can it do',
          'routine',
          'brief',
          'site',
          'inspiration',
        ],
        run: () => {
          requestAgentsIntent({ kind: 'ideas' });
          setView('agents');
        },
      },
      // One prompt: the New agent dialog with the cursor in "Describe the agent you want".
      {
        id: 'agents.describe',
        title: 'Describe a new agent…',
        icon: <PlusIcon size={14} />,
        category: 'navigation' as const,
        keywords: ['agents', 'create', 'draft', 'prompt', 'describe', 'one prompt', 'routine'],
        run: () => {
          requestAgentsIntent({ kind: 'new', template: DESCRIBE_START });
          setView('agents');
        },
      },
      // One per ready-made agent: the New agent dialog, opened on it.
      ...ROLE_TEMPLATES.map((t) => ({
        id: `agents.template.${t.id}`,
        title: `New agent: ${t.title}…`,
        icon: <PlusIcon size={14} />,
        category: 'navigation' as const,
        keywords: ['agents', 'create', 'template', 'ready-made', t.name.toLowerCase()],
        run: () => {
          requestAgentsIntent({ kind: 'new', template: t.id });
          setView('agents');
        },
      })),
      ...(setup && chiefId
        ? [
            {
              id: 'agents.teamSetup',
              title: `Continue ${SETUP_TITLE.toLowerCase()}`,
              icon: <AgentsIcon size={14} />,
              category: 'navigation' as const,
              keywords: ['agents', 'import', 'setup', 'logins', 'routines', 'say hi', 'checklist'],
              run: () => {
                resumeTeamSetup()
                  .then(() => {
                    requestAgentsIntent({ kind: 'open', agentId: chiefId });
                    setView('agents');
                  })
                  .catch((e: unknown) => showToast(errorText(e), 'error'));
              },
            },
          ]
        : []),
      {
        id: 'agents.team',
        title: 'What’s in flight',
        icon: <CollaboratorsIcon size={14} />,
        category: 'navigation',
        keywords: [
          'agents',
          'team',
          'tasks',
          'working',
          'approvals',
          'scheduled',
          'overview',
          'status',
        ],
        run: () => {
          requestAgentsIntent({ kind: 'open', agentId: TEAM_ID });
          setView('agents');
        },
      },
      {
        id: 'agents.search',
        title: 'Search agent conversations',
        icon: <SearchIcon size={14} />,
        category: 'navigation',
        shortcut: kbd('mod', 'F'),
        keywords: ['agents', 'find', 'messages', 'chat', 'history'],
        run: () => {
          requestAgentsIntent({ kind: 'search' });
          setView('agents');
        },
      },
      {
        id: 'agents.import',
        title: 'Import agents from another assistant…',
        icon: <DownloadIcon size={14} />,
        category: 'navigation',
        keywords: [
          'agents',
          'import',
          'migrate',
          'grok',
          'chatgpt',
          'claude',
          'bring over',
          'history',
          'setup',
        ],
        run: () => {
          requestAgentsIntent({ kind: 'import' });
          setView('agents');
        },
      },
      {
        id: 'agents.importExport',
        title: 'Import agents from an export file…',
        icon: <DownloadIcon size={14} />,
        category: 'navigation',
        keywords: [
          'agents',
          'import',
          'export',
          'file',
          'paste',
          'grok bot',
          'openbot',
          'openclaw',
          'hermes',
          'migrate',
        ],
        run: () => {
          requestAgentsIntent({ kind: 'import', from: 'paste' });
          setView('agents');
        },
      },
      {
        id: 'agents.importOtherApp',
        title: `Import agents from ${OTHER_APP_NAME}…`,
        icon: <DownloadIcon size={14} />,
        category: 'navigation',
        when: () => otherApp,
        keywords: ['agents', 'migrate', 'bring over', 'team', 'move', 'copy'],
        run: () => {
          requestAgentsIntent({ kind: 'import', from: 'otherApp' });
          setView('agents');
        },
      },
      {
        id: 'agents.browser',
        title: 'Let agents use your browser…',
        icon: <GlobeIcon size={14} />,
        category: 'navigation',
        keywords: [
          'agents',
          'browser',
          'chrome',
          'claude in chrome',
          'signed in',
          'extension',
          'logins',
        ],
        run: () => {
          requestAgentsIntent({ kind: 'browser' });
          setView('agents');
        },
      },
      {
        id: 'agents.checkReach',
        title: 'Check what your team can already reach',
        icon: <PlugIcon size={14} />,
        category: 'navigation',
        when: () => !!setup,
        keywords: ['agents', 'import', 'logins', 'reach', 'access', 'connected', 'check'],
        run: () => {
          checkTeamReach().catch((e: unknown) => showToast(errorText(e), 'error'));
          if (chiefId) requestAgentsIntent({ kind: 'open', agentId: chiefId });
          setView('agents');
        },
      },
      {
        id: 'agents.logins',
        title: 'Set up logins for agents…',
        icon: <PlugIcon size={14} />,
        category: 'navigation',
        keywords: [
          'agents',
          'logins',
          'sign in',
          'connect',
          'accounts',
          'gmail',
          'slack',
          'linkedin',
          'github',
          'what your team needs',
          'passwords',
        ],
        run: () => {
          requestAgentsIntent({ kind: 'logins' });
          setView('agents');
        },
      },
      {
        id: 'agents.apps',
        title: 'Connect an app for agents…',
        icon: <PlugIcon size={14} />,
        category: 'navigation',
        keywords: [
          'agents',
          'mcp',
          'gmail',
          'calendar',
          'slack',
          'notion',
          'linear',
          'connectors',
          'integrations',
        ],
        run: () => {
          requestAgentsIntent({ kind: 'apps' });
          setView('agents');
        },
      },
      {
        id: 'agents.routines',
        title: 'Routines',
        icon: <RoutineIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'routines', 'schedule', 'scheduled', 'all', 'overview', 'next run'],
        run: () => {
          requestAgentsIntent({ kind: 'routines' });
          setView('agents');
        },
      },
      {
        id: 'agents.routines.pauseAll',
        title: 'Pause all routines…',
        icon: <RoutineIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'routines', 'stop', 'freeze', 'quiet', 'every', 'bulk'],
        run: () => {
          requestAgentsIntent({ kind: 'routines', ask: 'pause' });
          setView('agents');
        },
      },
      {
        id: 'agents.routines.resumeAll',
        title: 'Resume all routines…',
        icon: <RoutineIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'routines', 'start', 'unpause', 'every', 'bulk'],
        run: () => {
          requestAgentsIntent({ kind: 'routines', ask: 'resume' });
          setView('agents');
        },
      },
      {
        id: 'agents.openLogs',
        title: 'Open logs',
        icon: <FileTextIcon size={14} />,
        category: 'navigation',
        keywords: ['logs', 'debug', 'why', 'died', 'error', 'finder', 'library', 'trace'],
        run: () => {
          // Finder opens outside the app: a quiet line says it happened.
          openLogs().then(
            () => showToast('Opened the logs folder in Finder', 'success'),
            (e: unknown) => showToast(`Couldn’t open the logs: ${errorText(e)}`, 'error')
          );
        },
      },
      ...GROUP_COMMANDS.map((c) => ({
        id: `agents.groups.${c.mode}`,
        title: c.title,
        icon: <AgentsIcon size={14} />,
        category: 'navigation' as const,
        when: () => groupMode !== c.mode,
        keywords: ['agents', 'group', 'groups', 'sidebar', 'organise', 'organize', ...c.keywords],
        run: () => {
          setGroupMode(c.mode);
          setView('agents');
        },
      })),
      {
        id: 'agents.sort.activity',
        title: 'Sort agents by recent activity',
        icon: <AgentsIcon size={14} />,
        category: 'navigation',
        when: () => sortMode === 'yours',
        keywords: ['agents', 'sort', 'order', 'chronological', 'recent', 'sidebar', 'reorder'],
        run: () => {
          setSortMode('activity');
          setView('agents');
        },
      },
      {
        id: 'agents.sort.yours',
        title: 'Sort agents in your own order',
        icon: <AgentsIcon size={14} />,
        category: 'navigation',
        when: () => sortMode === 'activity' && hasOwnOrder,
        keywords: ['agents', 'sort', 'order', 'custom', 'manual', 'sidebar', 'reorder', 'drag'],
        run: () => {
          setSortMode('yours');
          setView('agents');
        },
      },
      {
        id: 'agents.groups.new',
        title: 'New agent group…',
        icon: <PlusIcon size={14} />,
        category: 'navigation',
        keywords: ['agents', 'group', 'client', 'folder', 'sidebar', 'organise', 'organize'],
        run: () => {
          startNamingGroup();
          setView('agents');
        },
      },
      // Reachable any time, not only from the first-run screen: agents run on
      // this Mac, so they pause when it sleeps and stop when the app quits.
      ...STAY_ON_COMMANDS.map((c) => ({
        id: `agents.stayOn.${c.id}`,
        title: c.title,
        icon: <AgentsIcon size={14} />,
        category: 'navigation' as const,
        keywords: ['agents', 'awake', 'sleep', 'background', 'always on', 'login', 'close'],
        run: async () => {
          try {
            const result = await setStayOn(c.change);
            showToast(
              result.supported ? c.done : 'Only available on macOS',
              result.supported ? 'success' : 'info'
            );
          } catch (err) {
            showToast(`Couldn’t change that setting: ${errorText(err)}`, 'error');
          }
        },
      })),
      // One per agent, so typing its name in ⌘K opens it; its bound key
      // (which opens it from anywhere in Agents) shown as the shortcut.
      ...agents.map((agent) => ({
        id: `agents.open.${agent.id}`,
        title: `Open ${agent.name}`,
        icon: <AgentsIcon size={14} />,
        category: 'navigation' as const,
        shortcut: keyLookFor(agent).boundKey ?? undefined,
        keywords: ['agent', 'chat', 'key', ...(agent.role ? [agent.role] : [])],
        run: () => {
          requestAgentsIntent({ kind: 'open', agentId: agent.id });
          setView('agents');
        },
      })),
    ],
    [
      setView,
      agents,
      showToast,
      otherApp,
      setup,
      chiefId,
      chiefName,
      groupMode,
      sortMode,
      hasOwnOrder,
    ]
  );
}
