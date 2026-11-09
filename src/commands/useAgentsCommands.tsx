/**
 * Palette commands for Agents. Registered app-wide, so "New agent…" and
 * "Open Finance" work from anywhere: they switch to Agents mode and act there.
 *
 * @module commands/useAgentsCommands
 */

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  AgentsIcon,
  CollaboratorsIcon,
  DownloadIcon,
  GlobeIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  ZapIcon,
} from '@/components/icons';
import { useCommands } from './useCommands';
import { useOptionalToast } from '../contexts/ToastContext';
import { setStayOn, type StayOnChange } from '../lib/remoteAccess';
import { useAgentsSelector, type AgentsState } from '../lib/agentsStore';
import type { AppView } from '../lib/types';
import { AGENT_EVENTS, OTHER_APP_NAME, otherAppExists, TEAM_ID } from '../lib/agents';
import { DESCRIBE_START, ROLE_TEMPLATES } from '../lib/agentTemplates';
import {
  checkTeamReach,
  resumeTeamSetup,
  SETUP_TITLE,
  useResumableTeamSetup,
} from '../lib/teamSetup';

type AgentsIntent =
  | { kind: 'new'; template?: string }
  | { kind: 'import'; from?: 'otherApp' | 'paste' }
  | { kind: 'apps' }
  | { kind: 'search' }
  | { kind: 'ideas' }
  | { kind: 'logins' }
  | { kind: 'browser' }
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
  }, [onNewAgent, onImportAgents, onApps, onOpenAgent, onSearch, onIdeas, onLogins, onBrowser]);
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
    title: 'Keep this Mac awake for agents',
    change: { keepAwake: true },
    done: 'This Mac stays awake while the app is open',
  },
  {
    id: 'awakeOff',
    title: 'Let this Mac sleep again',
    change: { keepAwake: false },
    done: 'This Mac can sleep again; agents pause while it sleeps',
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
  const chiefId = agents.find((a) => a.isMain)?.id;
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
                  .catch((e: unknown) => showToast(String(e), 'error'));
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
          checkTeamReach().catch((e: unknown) => showToast(String(e), 'error'));
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
            showToast(`Couldn't change that setting: ${String(err)}`, 'error');
          }
        },
      })),
      // One per agent, so typing its name in ⌘K opens it.
      ...agents.map((agent) => ({
        id: `agents.open.${agent.id}`,
        title: `Open ${agent.name}`,
        icon: <AgentsIcon size={14} />,
        category: 'navigation' as const,
        keywords: ['agent', 'chat', ...(agent.role ? [agent.role] : [])],
        run: () => {
          requestAgentsIntent({ kind: 'open', agentId: agent.id });
          setView('agents');
        },
      })),
    ],
    [setView, agents, showToast, otherApp, setup, chiefId]
  );
}
