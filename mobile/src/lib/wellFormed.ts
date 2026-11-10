/**
 * A message from a Mac older or newer than this phone can arrive in a shape
 * the phone doesn't expect: a field missing, a number where a string was, a
 * kind it has never heard of. Every row reads `text`, `id`, `ts` and
 * `agentId` without checking, and a list sorts on `ts`, so those four are
 * made safe here, once, where messages come in (`sync.ts`); a field of the
 * wrong shape is dropped rather than drawn. A message that isn't one at all
 * (no id) is left out. What still throws while drawing is caught per row
 * (`RowBoundary`), which says so in a Line.
 */

import type {
  Agent,
  AgentMessage,
  AgentStatus,
  AgentsOverview,
  ProjectSummary,
  RoomView,
  SessionSummary,
} from '@shipstudio/companion-protocol';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Optional fields that are an object when present. */
const OBJECT_FIELDS = [
  'peer',
  'approval',
  'checkIn',
  'failure',
  'changes',
  'session',
  'work',
  'result',
  'revises',
  'remembered',
  'via',
] as const;

/** Optional fields that are a list when present. */
const LIST_FIELDS = ['attachments', 'mentions', 'decide', 'localLinks'] as const;

/** The message made safe to draw, or null when it isn't a message. */
export function asMessage(raw: unknown): AgentMessage | null {
  if (!isObject(raw)) return null;
  const id = raw.id;
  if (typeof id !== 'string' || !id) return null;
  const m: Record<string, unknown> = { ...raw };
  if (typeof m.agentId !== 'string') m.agentId = '';
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) m.ts = 0;
  // An unknown kind is drawn as a plain line of its text (chat.tsx's default).
  if (typeof m.kind !== 'string' || !m.kind) m.kind = 'note';
  if (typeof m.text !== 'string') {
    m.text = typeof m.text === 'number' || typeof m.text === 'boolean' ? String(m.text) : '';
  }
  if (m.room != null && (typeof m.room !== 'string' || !m.room)) delete m.room;
  if (m.clientId != null && typeof m.clientId !== 'string') delete m.clientId;
  for (const k of OBJECT_FIELDS) if (k in m && m[k] != null && !isObject(m[k])) delete m[k];
  for (const k of LIST_FIELDS) {
    if (!(k in m) || m[k] == null) continue;
    if (!Array.isArray(m[k])) delete m[k];
    else m[k] = (m[k] as unknown[]).filter(isObject);
  }
  return m as unknown as AgentMessage;
}

/** A page's messages, each made safe, the ones that aren't messages left out. */
export function asMessages(raw: unknown): AgentMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentMessage[] = [];
  for (const r of raw) {
    const m = asMessage(r);
    if (m) out.push(m);
  }
  return out;
}

/* ---- The overview, rooms and projects ------------------------------------------ */
//
// The lists every screen maps over, sorts and counts from, read the same way
// as messages: the fields screens read without checking are made safe, an
// entry with no id (or path) is left out, and a list that isn't one is empty.

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const objects = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isObject) : [];

/** Drop optional fields of the wrong shape. */
function trim(m: Record<string, unknown>, objectFields: string[], listFields: string[]) {
  for (const k of objectFields) if (k in m && m[k] != null && !isObject(m[k])) delete m[k];
  for (const k of listFields) {
    if (!(k in m) || m[k] == null) continue;
    if (!Array.isArray(m[k])) delete m[k];
    else m[k] = (m[k] as unknown[]).filter(isObject);
  }
}

const STATE = ['idle', 'working', 'waiting'];

/** A status made safe; anything unreadable is idle. */
export function asStatus(raw: unknown): AgentStatus {
  if (!isObject(raw)) return { state: 'idle', activity: null, since: null };
  const s: Record<string, unknown> = { ...raw };
  if (typeof s.state !== 'string' || !STATE.includes(s.state)) s.state = 'idle';
  if (typeof s.activity !== 'string') s.activity = null;
  if (typeof s.since !== 'number' || !Number.isFinite(s.since)) s.since = null;
  if ('room' in s && (typeof s.room !== 'string' || !s.room)) delete s.room;
  trim(s, ['work'], []);
  if (isObject(s.work) && !Array.isArray(s.work.steps)) delete s.work;
  return s as unknown as AgentStatus;
}

const AGENT_OBJECTS = [
  'avatar',
  'ranOn',
  'failure',
  'copy',
  'capabilities',
  'reach',
  'away',
  'context',
  'takeover',
];
const AGENT_LISTS = ['checkIns', 'watches', 'permissions', 'secrets'];
const AGENT_STRINGS = ['project', 'account', 'effort', 'routineModel', 'template', 'independence'];

function asAgent(raw: unknown): Agent | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const a: Record<string, unknown> = { ...raw };
  a.name = str(a.name, 'Agent');
  a.role = str(a.role);
  a.color = str(a.color);
  a.home = str(a.home);
  a.status = asStatus(a.status);
  a.engine = a.engine === 'codex' || a.engine === 'opencode' ? a.engine : 'claude';
  for (const k of ['shape', 'createdAt', 'lastActivityAt', 'unread', 'pendingApprovals'])
    a[k] = num(a[k]);
  for (const k of ['isMain', 'pinned', 'hidden', 'muted']) a[k] = a[k] === true;
  if (typeof a.preview !== 'string') a.preview = null;
  if (typeof a.sessionId !== 'string') a.sessionId = null;
  if (typeof a.model !== 'string') a.model = null;
  for (const k of AGENT_STRINGS) if (k in a && a[k] != null && typeof a[k] !== 'string') delete a[k];
  trim(a, AGENT_OBJECTS, AGENT_LISTS);
  return a as unknown as Agent;
}

/** The overview made safe to draw, or null when it isn't one. */
export function asOverview(raw: unknown): AgentsOverview | null {
  if (!isObject(raw)) return null;
  const o: Record<string, unknown> = { ...raw };
  const agents: Agent[] = [];
  if (Array.isArray(raw.agents)) {
    for (const r of raw.agents) {
      const a = asAgent(r);
      if (a) agents.push(a);
    }
  }
  o.agents = agents;
  o.engineReady = o.engineReady === true;
  o.engines = objects(o.engines).filter((e) => typeof e.id === 'string');
  if (o.defaults != null && !isObject(o.defaults)) delete o.defaults;
  for (const k of ['independence', 'importChoice'])
    if (k in o && o[k] != null && typeof o[k] !== 'string') delete o[k];
  return o as unknown as AgentsOverview;
}

function asRoom(raw: unknown): RoomView | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  const r: Record<string, unknown> = { ...raw };
  r.name = str(r.name, 'Room');
  r.members = strings(r.members);
  r.waiting = strings(r.waiting);
  for (const k of ['createdAt', 'lastActivityAt', 'unread', 'turnsUsed', 'turnCap'])
    r[k] = num(r[k]);
  r.muted = r.muted === true;
  for (const k of ['lead', 'preview', 'purpose', 'createdBy'])
    if (k in r && r[k] != null && typeof r[k] !== 'string') delete r[k];
  return r as unknown as RoomView;
}

/** Every room made safe, the ones that aren't rooms left out; null when it isn't a list. */
export function asRooms(raw: unknown): RoomView[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RoomView[] = [];
  for (const r of raw) {
    const room = asRoom(r);
    if (room) out.push(room);
  }
  return out;
}

function asSession(raw: unknown): SessionSummary | null {
  if (!isObject(raw)) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  const s: Record<string, unknown> = { ...raw };
  s.tab = num(s.tab);
  s.lastOutputAt = num(s.lastOutputAt);
  if (typeof s.state !== 'string' || !s.state) s.state = 'exited';
  for (const k of ['cli', 'activity']) if (k in s && s[k] != null && typeof s[k] !== 'string') delete s[k];
  if (s.question != null) {
    const q = s.question;
    if (!isObject(q) || typeof q.question !== 'string') delete s.question;
    else
      s.question = {
        ...q,
        options: objects(q.options).filter(
          (o) => typeof o.key === 'string' && typeof o.label === 'string'
        ),
      };
  }
  return s as unknown as SessionSummary;
}

/** One project made safe, or null when it isn't one (no path). */
export function asProject(raw: unknown): ProjectSummary | null {
  if (!isObject(raw)) return null;
  const path = raw.path;
  if (typeof path !== 'string' || !path) return null;
  const p: Record<string, unknown> = { ...raw };
  p.name = str(p.name, path.split('/').pop() || path);
  p.dirtyFiles = num(p.dirtyFiles);
  if ('branch' in p && p.branch != null && typeof p.branch !== 'string') delete p.branch;
  const sessions: SessionSummary[] = [];
  if (Array.isArray(raw.sessions)) {
    for (const r of raw.sessions) {
      const s = asSession(r);
      if (s) sessions.push(s);
    }
  }
  p.sessions = sessions;
  return p as unknown as ProjectSummary;
}

/** Every project made safe; null when it isn't a list. */
export function asProjects(raw: unknown): ProjectSummary[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ProjectSummary[] = [];
  for (const r of raw) {
    const p = asProject(r);
    if (p) out.push(p);
  }
  return out;
}
