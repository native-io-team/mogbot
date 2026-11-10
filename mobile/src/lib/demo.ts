/**
 * The demo: a look at the app with sample agents, for someone with no Mac
 * to pair (App Review, or a person deciding whether to set it up).
 *
 * It is a `Transport` that never touches the network. Nothing is saved: no
 * keychain entry, no offline copy, no drafts, no outbox, so a relaunch is
 * back on the welcome screen. It can never be mistaken for a Mac: its name
 * is "Demo Mac", every screen that lists agents or holds a chat says
 * "Demo" (`DemoBanner`), and anything a sample agent can't do answers that
 * it's the demo. A real pairing replaces it; the demo never replaces a
 * pairing (`startDemo` refuses while one exists).
 *
 * Everything here is fictional: the café, the people and the addresses.
 */

import {
  SUPPORTED,
  boundKeyFor,
  distinctColorway,
  keyLookFor,
  type Agent,
  type AgentMessage,
  type AgentsOverview,
  type CompanionEvent,
  type Cursor,
  type LinkState,
  type MacStatus,
  type MethodName,
  type Params,
  type ProjectSummary,
  type RefusedFrame,
  type Result,
  type Route,
  type SearchHit,
  type WelcomeFrame,
} from '@shipstudio/companion-protocol';
import type { Credentials } from './pairing';
import { agentColorKeys } from './theme';
import { WireFailure } from './transport';

export const DEMO_SERVER_ID = 'demo';
export const DEMO_MAC_NAME = 'Demo Mac';

/** What a sample agent says when asked for real work. */
export const DEMO_REPLY =
  'This is the demo, so I can’t do real work. Pair this phone with your Mac and your own agents answer here.';

/** What anything the demo doesn't offer answers. */
export const NOT_IN_DEMO = 'That isn’t in the demo. Pair this phone with your Mac to use it.';

/** The bar over every demo chat. */
export const DEMO_BAR = {
  title: 'Demo · sample agents',
  detail: 'Nothing you send reaches a Mac or anyone else',
};

export const isDemo = (c: Pick<Credentials, 'serverId'> | null | undefined) =>
  c?.serverId === DEMO_SERVER_ID;

/** Never saved: `session.startDemo` holds it in memory only. */
export function demoCredentials(now = Date.now()): Credentials {
  return {
    serverId: DEMO_SERVER_ID,
    name: DEMO_MAC_NAME,
    routes: [],
    deviceId: 'demo-phone',
    token: '',
    secretKey: '',
    pairedAt: now,
    fingerprint: 'demo',
  };
}

/**
 * What the demo answers. Everything else is left out of `welcome.methods`,
 * so the screens hide it as they do for an older Mac.
 */
export const DEMO_METHODS = [
  'system.status',
  'agents.overview',
  'agents.messages',
  'agents.send',
  'agents.stop',
  'agents.answerApproval',
  'agents.focus',
  'agents.search',
  'projects.list',
] as const satisfies readonly MethodName[];

/** The agents' colour keys by name (theme.ts holds the colours themselves). */
const tint = Object.fromEntries(agentColorKeys.all.map((k) => [k, k])) as Record<
  (typeof agentColorKeys.all)[number],
  string
>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const PROJECT = '/Users/you/Projects/northwind-site';

const base =
  (now: number) =>
  (id: string, name: string, role: string, color: string, extra: Partial<Agent>): Agent => ({
    id,
    name,
    role,
    shape: 0,
    color,
    isMain: false,
    pinned: false,
    hidden: false,
    sessionId: null,
    createdAt: now - 21 * 24 * HOUR,
    lastActivityAt: now - HOUR,
    preview: null,
    unread: 0,
    pendingApprovals: 0,
    engine: 'claude',
    model: null,
    muted: false,
    status: { state: 'idle', activity: null, since: null },
    home: `/Users/you/Agents/${id}`,
    ...extra,
  });

/**
 * Each its key, as the Mac fills one in: a free letter of its name, the Chief
 * first, and a colourway no one else wears with the same icon.
 */
function withKeys(agents: Agent[]): Agent[] {
  const used: string[] = [];
  const worn: [string, string][] = [];
  return agents.map((a) => {
    const look = keyLookFor(a);
    const icon = look.icon;
    const colorway = a.colorway ? look.colorway : distinctColorway(look.colorway, icon, worn);
    worn.push([colorway, icon]);
    const boundKey = boundKeyFor(a.name, used) ?? undefined;
    if (boundKey) used.push(boundKey);
    return { ...a, colorway, icon, boundKey };
  });
}

function demoAgents(now: number): Agent[] {
  const agent = base(now);
  return [
    agent('chief', 'Chief of Staff', 'Runs the team', tint.white, {
      isMain: true,
      pinned: true,
      lastActivityAt: now - 4 * MIN,
      unread: 1,
      preview: 'Two things need you this morning. The rest is moving.',
      checkIns: [
        {
          id: 'demo_brief',
          note: 'Morning brief: what needs me today',
          repeat: { kind: 'days', days: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
          nextAt: now + 23 * HOUR,
          createdAt: now - 14 * 24 * HOUR,
          paused: false,
        },
      ],
    }),
    agent('inbox', 'Inbox', 'Email and replies', tint.purple, {
      lastActivityAt: now - 9 * MIN,
      pendingApprovals: 1,
      preview: 'Needs your OK',
    }),
    agent('books', 'Books', 'Invoices and receipts', tint.green, {
      lastActivityAt: now - MIN,
      preview: 'Matching October’s receipts to the card statement.',
      status: {
        state: 'working',
        activity: 'Matching receipts to the card statement',
        since: now - 6 * MIN,
        work: {
          startedAt: now - 6 * MIN,
          stepCount: 3,
          fileCount: 1,
          steps: [
            {
              at: now - 6 * MIN,
              kind: 'read',
              label: 'Read october-statement.csv',
              endedAt: now - 6 * MIN + 2000,
            },
            {
              at: now - 5 * MIN,
              kind: 'search',
              label: 'Looked for receipts from October',
              endedAt: now - 4 * MIN,
            },
            { at: now - 3 * MIN, kind: 'edit', label: 'Updating receipts.xlsx' },
          ],
          doing: 'Matching receipts to the card statement',
        },
      },
    }),
    agent('site', 'Website', 'The café’s site', tint.blue, {
      lastActivityAt: now - 25 * MIN,
      project: PROJECT,
      preview: 'The winter menu page is ready to look at.',
    }),
    agent('research', 'Research', 'Suppliers and prices', tint.amber, {
      lastActivityAt: now - 20 * HOUR,
      preview: 'Three roasters can deliver weekly. Summary attached.',
    }),
  ];
}

function demoMessages(now: number): Record<string, AgentMessage[]> {
  const out: Record<string, AgentMessage[]> = {};
  const add = (agentId: string, m: Omit<AgentMessage, 'id' | 'agentId'>) => {
    const list = (out[agentId] ??= []);
    list.push({ id: `demo_${agentId}_${list.length}`, agentId, ...m });
  };

  add('chief', { ts: now - 16 * HOUR, kind: 'user', text: 'What’s on for tomorrow?' });
  add('chief', {
    ts: now - 16 * HOUR + MIN,
    kind: 'agent',
    text: 'Tomorrow:\n\n- **9:00** Call with the bakery about the holiday order\n- **Noon** Payroll goes out\n- **Afternoon** Website finishes the winter menu page\n\nNothing needs you tonight.',
  });
  add('chief', {
    ts: now - 5 * MIN,
    kind: 'check_in',
    text: 'Morning brief: what needs me today',
    checkIn: { dueAt: now - 5 * MIN, late: false, repeats: true },
  });
  add('chief', {
    ts: now - 4 * MIN,
    kind: 'agent',
    text: 'Good morning. Two things need you:\n\n1. **Inbox** wrote a reply to Dana about the wholesale order. It waits for your OK before it sends.\n2. **Website** finished the winter menu page. Have a look when you can.\n\n**Books** is matching October’s receipts and should be done within the hour.',
  });

  add('inbox', {
    ts: now - 12 * MIN,
    kind: 'user',
    text: 'Answer Dana about the wholesale order. 40 bags is fine, and we can ship Thursday.',
  });
  add('inbox', {
    ts: now - 10 * MIN,
    kind: 'agent',
    text: 'Here’s the reply:\n\n> Hi Dana,\n>\n> 40 bags works for us. We’ll ship them Thursday morning, and you’ll have tracking by the afternoon.\n>\n> Thanks again,\n> Sam\n\nI’ll send it from your work address once you allow it.',
  });
  add('inbox', {
    ts: now - 9 * MIN,
    kind: 'approval',
    text: '',
    approval: {
      requestId: 'demo_send_dana',
      title: 'Send an email as you',
      summary: 'Send the reply to Dana from your work address.',
      detail:
        'To: dana@example.com\nSubject: Re: Wholesale order\n\n40 bags works for us. We’ll ship them Thursday morning.',
      status: 'pending',
    },
  });

  add('books', {
    ts: now - 7 * MIN,
    kind: 'user',
    text: 'Match October’s receipts to the card statement and tell me what’s missing.',
  });

  add('site', {
    ts: now - 3 * HOUR,
    kind: 'user',
    text: 'Put the winter menu on the site, in the same style as the summer one.',
  });
  add('site', {
    ts: now - 25 * MIN,
    kind: 'agent',
    text: 'The winter menu page is done.',
    result: {
      id: 'demo_winter_menu',
      version: 1,
      title: 'Winter menu page',
      summary:
        'A new /menu page with the eight winter drinks and four pastries, laid out like the summer menu, with prices from your spreadsheet.',
      project: PROJECT,
      checked: ['The site builds with no errors', 'The page reads well on a phone and a laptop'],
      notVerified: ['Prices against the till: they’re copied from the spreadsheet'],
    },
  });

  add('research', {
    ts: now - 22 * HOUR,
    kind: 'user',
    text: 'Find roasters near us that can deliver every week.',
  });
  add('research', {
    ts: now - 20 * HOUR,
    kind: 'agent',
    text: 'Three can deliver weekly:\n\n| Roaster | Delivers | Per kg |\n| --- | --- | --- |\n| Hillside | Tue | $24 |\n| Copper Kettle | Mon | $27 |\n| North Pier | Weekdays | $29 |\n\nHillside is the cheapest and roasts to order. North Pier is the most flexible. Want me to ask Hillside for a sample?',
  });
  return out;
}

function demoStatus(): MacStatus {
  return {
    name: DEMO_MAC_NAME,
    appVersion: 'demo',
    power: { keepAwake: true, lidClosedMode: 'unknown', onBattery: 'no' },
    claude: { installed: true, signedIn: 'yes' },
    routes: [],
  };
}

function demoProjects(now: number): ProjectSummary[] {
  void now;
  return [{ path: PROJECT, name: 'northwind-site', branch: 'main', dirtyFiles: 0, sessions: [] }];
}

type Listener<T extends unknown[]> = (...args: T) => void;

/**
 * The demo's stand-in for `DirectTransport`, with the same surface the
 * session and screens use. Offline by construction: there is no socket.
 */
export class DemoTransport {
  state: LinkState = { kind: 'connecting', attempt: 0 };
  readonly latencyMs: number | null = null;
  lastSeenAt = 0;
  /** Never: secrets and sign-ins check this and refuse. */
  readonly identityVerified = false;
  readonly authHeaders: Record<string, string> = {};
  readonly baseUrl = '';

  private agents: Agent[];
  private messages: Record<string, AgentMessage[]>;
  private seq = 0;
  private readonly epoch = 'demo';
  private closed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private events = new Set<Listener<[CompanionEvent, Cursor | undefined]>>();
  private states = new Set<Listener<[LinkState]>>();
  private welcomes = new Set<Listener<[WelcomeFrame]>>();
  private sent = new Map<string, AgentMessage>();

  constructor(private readonly now: () => number = Date.now) {
    const t = now();
    this.agents = withKeys(demoAgents(t));
    this.messages = demoMessages(t);
    // After the session has subscribed, as a real link's first frames are.
    this.later(0, () => this.open());
  }

  get route(): Route {
    return { kind: 'tailscale', url: 'demo:' };
  }

  onEvent(listener: Listener<[CompanionEvent, Cursor | undefined]>) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  onState(listener: Listener<[LinkState]>) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
  onWelcome(listener: Listener<[WelcomeFrame]>) {
    this.welcomes.add(listener);
    return () => this.welcomes.delete(listener);
  }
  onRefused(listener: Listener<[RefusedFrame]>) {
    void listener;
    return () => {};
  }

  attachmentUrl(): string {
    return '';
  }
  setForeground(foreground: boolean) {
    void foreground;
  }
  retryNow() {}

  close() {
    this.closed = true;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.events.clear();
    this.states.clear();
    this.welcomes.clear();
  }

  /** Files never leave the phone in the demo. */
  upload(file: { uri: string; name: string; mime: string }): Promise<never> {
    void file;
    return Promise.reject(refuse());
  }
  download(source: { blobId: string } | { agentId: string; path: string }): Promise<never> {
    void source;
    return Promise.reject(refuse());
  }

  request<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    try {
      return Promise.resolve(this.answer(method, params) as Result<M>);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ---- What it answers -------------------------------------------------------------

  private answer(method: MethodName, params: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'system.status':
        return demoStatus();
      case 'agents.overview':
        return this.overview();
      case 'projects.list':
        return demoProjects(this.now());
      case 'agents.focus':
        if (typeof p.agentId === 'string') this.read(p.agentId);
        return null;
      case 'agents.messages': {
        const list = this.messages[String(p.agentId)] ?? [];
        return { messages: [...list], asOf: this.cursor(), more: false };
      }
      case 'agents.send':
        return this.send(String(p.agentId), text(p.text), String(p.clientId));
      case 'agents.stop':
        return false;
      case 'agents.answerApproval':
        return this.answerApproval(String(p.agentId), String(p.requestId), p.allow === true);
      case 'agents.search':
        return this.search(text(p.query));
      default:
        throw refuse();
    }
  }

  private open() {
    if (this.closed) return;
    const t = this.now();
    this.setState({ kind: 'connected', route: 'tailscale', since: t });
    const welcome: WelcomeFrame = {
      t: 'welcome',
      protocol: SUPPORTED.max,
      server: { id: DEMO_SERVER_ID, name: DEMO_MAC_NAME, appVersion: 'demo' },
      deviceId: 'demo-phone',
      resume: 'snapshot',
      methods: [...DEMO_METHODS],
    };
    this.welcomes.forEach((l) => l(welcome));
    this.emit({
      type: 'sync.snapshot',
      cursor: this.cursor(),
      overview: this.overview(),
      status: demoStatus(),
      projects: demoProjects(t),
    });
    this.emit({ type: 'sync.caughtUp', cursor: this.cursor() });
  }

  private overview(): AgentsOverview {
    return {
      agents: this.agents.map((a) => ({ ...a })),
      engineReady: true,
      engines: [
        { id: 'claude', label: 'Claude Code', installed: true, signedIn: true, models: [] },
      ],
    };
  }

  private send(agentId: string, text: string, clientId: string): AgentMessage {
    const known = this.sent.get(clientId);
    if (known) return known;
    if (!this.agent(agentId)) throw refuse();
    if (!text.trim()) throw refuse('Type a message first.');
    const t = this.now();
    const m: AgentMessage = {
      id: `demo_sent_${this.sent.size}`,
      agentId,
      ts: t,
      kind: 'user',
      text,
      clientId,
    };
    this.sent.set(clientId, m);
    this.put(m);
    this.touch(agentId, text, { state: 'working', activity: 'Thinking', since: t });
    this.later(1200, () => {
      this.put({
        id: `${m.id}_reply`,
        agentId,
        ts: this.now(),
        kind: 'agent',
        text: DEMO_REPLY,
      });
      this.touch(agentId, DEMO_REPLY, { state: 'idle', activity: null, since: null });
    });
    return m;
  }

  private answerApproval(agentId: string, requestId: string, allow: boolean): null {
    const list = this.messages[agentId] ?? [];
    const card = list.find((m) => m.approval?.requestId === requestId);
    if (!card?.approval || card.approval.status !== 'pending') {
      throw refuse('That card was already answered.');
    }
    this.put({ ...card, approval: { ...card.approval, status: allow ? 'allowed' : 'denied' } });
    const a = this.agent(agentId);
    if (a) a.pendingApprovals = Math.max(0, a.pendingApprovals - 1);
    const reply = allow
      ? 'In the demo nothing is sent. On your Mac, Inbox would send it now and say so here.'
      : 'OK, I won’t send it.';
    this.later(600, () => {
      this.put({ id: `${card.id}_answer`, agentId, ts: this.now(), kind: 'agent', text: reply });
      this.touch(agentId, reply);
    });
    this.registry();
    return null;
  }

  private search(query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.values(this.messages)
      .flat()
      .filter((m) => m.text.toLowerCase().includes(q))
      .map((m) => {
        const a = this.agent(m.agentId);
        return {
          agentId: m.agentId,
          agentName: a?.name ?? '',
          agentColor: a?.color ?? tint.white,
          messageId: m.id,
          ts: m.ts,
          kind: m.kind,
          snippet: m.text.slice(0, 160),
        };
      })
      .reverse();
  }

  // ---- State ------------------------------------------------------------------------

  private agent(id: string) {
    return this.agents.find((a) => a.id === id);
  }

  private read(agentId: string) {
    const a = this.agent(agentId);
    if (a?.unread) {
      a.unread = 0;
      this.registry();
    }
  }

  private put(m: AgentMessage) {
    const list = (this.messages[m.agentId] ??= []);
    const i = list.findIndex((x) => x.id === m.id);
    if (i === -1) list.push(m);
    else list[i] = m;
    this.emit({ type: 'agents.message', message: m });
  }

  private touch(agentId: string, preview: string, status?: Agent['status']) {
    const a = this.agent(agentId);
    if (!a) return;
    a.preview = preview;
    a.lastActivityAt = this.now();
    if (status) {
      a.status = status;
      this.emit({ type: 'agents.status', agentId, status });
    }
    this.registry();
  }

  private registry() {
    this.emit({ type: 'agents.registry', overview: this.overview() });
  }

  private cursor(): Cursor {
    return { epoch: this.epoch, seq: this.seq };
  }

  private emit(event: CompanionEvent) {
    if (this.closed) return;
    const journaled = event.type !== 'sync.snapshot' && event.type !== 'sync.caughtUp';
    if (journaled) this.seq += 1;
    const cursor = journaled ? this.cursor() : undefined;
    this.lastSeenAt = this.now();
    this.events.forEach((l) => l(event, cursor));
  }

  private setState(state: LinkState) {
    this.state = state;
    this.states.forEach((l) => l(state));
  }

  private later(ms: number, fn: () => void) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(id);
  }
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');

const refuse = (message = NOT_IN_DEMO) =>
  new WireFailure({ type: 'Protocol', code: 'refused', message });
