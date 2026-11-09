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

import type { AgentMessage } from '@shipstudio/companion-protocol';

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
