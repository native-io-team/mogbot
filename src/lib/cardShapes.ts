/**
 * Reading a card's payload field by field before it's drawn: a result,
 * secret or plan card from an older or newer build (or a bug on the Mac's
 * side) may arrive with a part missing or the wrong shape. Each reader keeps
 * what is readable and drops what isn't, so the card draws what it can
 * instead of throwing to its fallback.
 *
 * Nothing is invented: a dropped list is simply not shown, as when the agent
 * gave none. Only the headline words fall back to a neutral phrase, so the
 * card still says what it is.
 *
 * @module lib/cardShapes
 */

import type { Attachment, PlanAction, PlanCard } from '../../packages/companion-protocol/src/model';
import type {
  ResultCard,
  ResultItem,
  TestReport,
  TestStep,
} from '../../packages/companion-protocol/src/results';
import type { SecretField, SecretKind, SecretRequest } from './agentSecrets';

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A list of lines: non-strings dropped; absent when nothing was readable. */
const lines = (v: unknown): string[] | undefined => {
  const out = list(v).filter((l): l is string => typeof l === 'string' && l.trim() !== '');
  return out.length ? out : undefined;
};

function attachment(v: unknown): Attachment | null {
  if (!isObject(v)) return null;
  const path = text(v.path);
  if (!path) return null;
  return {
    path,
    name: text(v.name) || path.split('/').pop() || path,
    mime: text(v.mime) ?? '',
    size: typeof v.size === 'number' && Number.isFinite(v.size) ? v.size : 0,
  };
}

function resultItem(v: unknown): ResultItem | null {
  if (!isObject(v)) return null;
  const label = text(v.label);
  if (v.kind === 'file') {
    const file = attachment(v.file);
    if (!file) return null;
    const role = v.role === 'before' || v.role === 'after' ? v.role : undefined;
    return {
      kind: 'file',
      file,
      ...(label ? { label } : {}),
      ...(role ? { role } : {}),
      ...(text(v.page) ? { page: text(v.page) } : {}),
    };
  }
  if (v.kind === 'link') {
    const url = text(v.url);
    return url ? { kind: 'link', url, ...(label ? { label } : {}) } : null;
  }
  return null;
}

function testStep(v: unknown): TestStep | null {
  if (!isObject(v)) return null;
  const label = text(v.label);
  if (!label) return null;
  const shot = attachment(v.shot);
  return {
    kind: (text(v.kind) ?? 'note') as TestStep['kind'],
    label,
    ok: v.ok !== false,
    ts: typeof v.ts === 'number' ? v.ts : 0,
    ...(shot ? { shot } : {}),
  };
}

function testReport(v: unknown): TestReport | undefined {
  if (!isObject(v)) return undefined;
  const steps = list(v.steps)
    .map(testStep)
    .filter((s): s is TestStep => s !== null);
  return {
    outcome: v.outcome === 'broken' ? 'broken' : 'passed',
    summary: text(v.summary) ?? '',
    ...(lines(v.broken) ? { broken: lines(v.broken) } : {}),
    ...(lines(v.consoleErrors) ? { consoleErrors: lines(v.consoleErrors) } : {}),
    ...(steps.length ? { steps } : {}),
    ...(v.onCopy === true ? { onCopy: true } : {}),
  };
}

/** A result card as far as it can be read. */
export function readResultCard(v: unknown): ResultCard {
  const raw = isObject(v) ? v : {};
  const items = list(raw.items)
    .map(resultItem)
    .filter((i): i is ResultItem => i !== null);
  const version = Number(raw.version);
  const test = testReport(raw.test);
  return {
    id: text(raw.id) ?? '',
    version: Number.isFinite(version) && version >= 1 ? Math.floor(version) : 1,
    title: text(raw.title) || 'A result',
    summary: text(raw.summary) ?? '',
    ...(items.length ? { items } : {}),
    ...(lines(raw.checked) ? { checked: lines(raw.checked) } : {}),
    ...(lines(raw.notVerified) ? { notVerified: lines(raw.notVerified) } : {}),
    ...(text(raw.changes) ? { changes: text(raw.changes) } : {}),
    ...(text(raw.project) ? { project: text(raw.project) } : {}),
    ...(test ? { test } : {}),
    ...(raw.checkpoint === true ? { checkpoint: true } : {}),
  };
}

const SECRET_KINDS: SecretKind[] = ['password', 'api_key', 'token', 'other'];

/**
 * A secret request as far as it can be read. Fields without a variable name
 * are dropped (there'd be nowhere to put the value); a request with none
 * left can't be saved, only declined.
 */
export function readSecretRequest(v: unknown): SecretRequest {
  const raw = isObject(v) ? v : {};
  const fields = list(raw.fields)
    .map((f): SecretField | null => {
      if (!isObject(f)) return null;
      const env = text(f.env);
      return env ? { env, label: text(f.label) || env } : null;
    })
    .filter((f): f is SecretField => f !== null);
  const kind = SECRET_KINDS.find((k) => k === raw.kind) ?? 'other';
  return {
    name: text(raw.name) || 'secret',
    purpose: text(raw.purpose) ?? '',
    kind,
    fields,
    reference: text(raw.reference) ?? '',
  };
}

/** A plan as far as it can be read: actions without a summary are dropped. */
export function readPlan(v: unknown): PlanCard {
  const raw = isObject(v) ? v : {};
  const actions = list(raw.actions)
    .map((a): PlanAction | null => {
      if (!isObject(a)) return null;
      const summary = text(a.summary);
      if (!summary) return null;
      const said = text(a.text);
      return {
        kind: (text(a.kind) ?? 'request') as PlanAction['kind'],
        summary,
        target: text(a.target) ?? '',
        ...(said ? { text: said } : {}),
      };
    })
    .filter((a): a is PlanAction => a !== null);
  const why = text(raw.why);
  return { actions, ...(why ? { why } : {}) };
}
