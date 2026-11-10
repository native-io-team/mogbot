/**
 * Answering from the Lock Screen: Allow / Deny on an approval's
 * notification, without opening the app.
 *
 * - **What gets buttons.** A card the Mac marked low-risk whose whole
 *   content fits in the notification (`answersInPlace`) and that has a plain
 *   pair of answers. Anything risky (deleting for good, money, credentials,
 *   pushing, publishing, sending: `approval.risk`, decided on the Mac) or
 *   unclassified, anything longer, and every key, login, session question,
 *   step-in or three-way card, gets **Review** instead, which opens it in
 *   full. Nobody allows what they couldn't read, or something risky from a
 *   Lock Screen.
 * - **Allow needs the phone unlocked.** Every card that reaches you is above
 *   your independence level (the rest were answered for you), so Allow is
 *   always `isAuthenticationRequired` on iOS; on Android, where an action
 *   can't ask for that, Allow opens the app (unlocking it) and answers there.
 *   Deny is the safe answer and works locked.
 * - **The words are redacted** (`redact`): no token, key or password that a
 *   command carries is ever shown on the Lock Screen. A card where anything
 *   was redacted isn't "whole" any more, so it gets Review.
 * - **The payload is ids only**: the agent, the message, the request.
 * - **The Mac decides.** An answer goes through `agents.answerApproval`
 *   like any other: the card's claim (`answer_gate.rs`) takes exactly one
 *   answer, and a second hears "already answered". When the answer doesn't
 *   land (answered elsewhere, the Mac out of reach), a notification says so;
 *   it never goes silent.
 *
 * Who posts them: the phone itself, from the live connection, while it is
 * in the background (`alertApproval`, called from the session). A push from
 * the relay is content-free by design ("<Agent> needs you"), so it carries no
 * buttons: tapping it opens the request in full.
 */

import type { Agent, AgentMessage, Approval, PlanAction } from '@shipstudio/companion-protocol';
import { GATE_ALLOW, GATE_DENY } from '@shipstudio/companion-protocol';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { askingLine } from './agents';
import { answersInPlace } from './needsYou';
import type { Target } from './notify';

/** Action ids, as the response hands them back. */
export const ACTION = { allow: 'allow', deny: 'deny', review: 'review' } as const;

/** One category per pair of words, and Review for the rest. */
export const CATEGORY = {
  answer: 'ask-answer',
  gate: 'ask-gate',
  front: 'ask-front',
  handoff: 'ask-handoff',
  review: 'ask-review',
} as const;
export type CategoryId = (typeof CATEGORY)[keyof typeof CATEGORY];

const WORDS: Record<Exclude<CategoryId, 'ask-review'>, [deny: string, allow: string]> = {
  [CATEGORY.answer]: ['Deny', 'Allow'],
  [CATEGORY.gate]: [GATE_DENY, GATE_ALLOW],
  [CATEGORY.front]: ['Not now', 'Check again'],
  [CATEGORY.handoff]: ['Ignore', 'Save to memory'],
};

/** What iOS shows with previews off, and the summary of a stack. */
const PLACEHOLDER = 'An agent needs your OK';

/**
 * The categories as the OS gets them. Pure, so the security rules (Allow
 * always asks for the unlock, Deny never opens the app) are tested.
 */
export function categories(platform: string): Notifications.NotificationCategory[] {
  const ios = platform === 'ios';
  const answerCats = (Object.keys(WORDS) as (keyof typeof WORDS)[]).map((id) => {
    const [deny, allow] = WORDS[id];
    return {
      identifier: id,
      actions: [
        {
          identifier: ACTION.deny,
          buttonTitle: deny,
          options: { opensAppToForeground: false, isDestructive: ios },
        },
        {
          identifier: ACTION.allow,
          buttonTitle: allow,
          // iOS asks for Face ID / the passcode first; Android can't, so the
          // app opens (which unlocks the phone) and answers there.
          options: ios
            ? { opensAppToForeground: false, isAuthenticationRequired: true }
            : { opensAppToForeground: true },
        },
      ],
      options: { previewPlaceholder: PLACEHOLDER, showTitle: true },
    };
  });
  return [
    ...answerCats,
    {
      identifier: CATEGORY.review,
      actions: [
        {
          identifier: ACTION.review,
          buttonTitle: 'Review',
          options: { opensAppToForeground: true },
        },
      ],
      options: { previewPlaceholder: PLACEHOLDER, showTitle: true },
    },
  ];
}

/** Once per launch. Fails quietly (Expo Go, web). */
export async function setupCategories() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  for (const c of categories(Platform.OS)) {
    await Notifications.setNotificationCategoryAsync(c.identifier, c.actions, c.options).catch(
      () => null
    );
  }
}

// ---- Redaction ------------------------------------------------------------------

const MASK = '••••';

/** Known token shapes, then `key=value` pairs whose key names a secret. */
const PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(\/\/[^\s/:@]+:)[^\s/@]+@/g,
  /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth|key|credential)s?["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** A long run of letters and digits mixed: what a key looks like when nothing names it. */
const OPAQUE = /\b[A-Za-z0-9+/_-]{32,}={0,2}/g;
const looksRandom = (s: string) => /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);

/**
 * The text with anything that looks like a credential masked. Errs toward
 * masking: a notification that hides a harmless id costs a tap on Review; one
 * that shows a key on a Lock Screen can't be taken back.
 */
export function redact(text: string): { text: string; masked: boolean } {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p, (match: string, keep?: unknown) => {
      // The pattern kept a prefix ("Bearer ", "token=", "//user:"): keep it, mask the rest.
      if (typeof keep === 'string' && match.startsWith(keep) && keep.length < match.length) {
        return /^(Bearer|Basic|Token)$/i.test(keep)
          ? `${keep} ${MASK}`
          : `${keep}${MASK}${match.endsWith('@') ? '@' : ''}`;
      }
      return MASK;
    });
  }
  out = out.replace(OPAQUE, (m) => (looksRandom(m) ? MASK : m));
  return { text: out, masked: out !== text };
}

// ---- What a notification says --------------------------------------------------

/** No more than this on a Lock Screen; a longer card opens in full. */
const BODY_MAX = 180;

const clip = (s: string) => (s.length > BODY_MAX ? `${s.slice(0, BODY_MAX - 1).trimEnd()}…` : s);

/** Cards that never answer from a notification: they open the app. */
const opensOnly = (a: Approval) =>
  !!(a.secret || a.login || a.prompt || a.connector || a.stepIn || a.crossover);

function categoryOf(a: Approval): CategoryId {
  if (a.gate) return CATEGORY.gate;
  if (a.front) return CATEGORY.front;
  if (a.handoff) return CATEGORY.handoff;
  return CATEGORY.answer;
}

/** The whole of what a card asks, as plain text: what Allow would agree to. */
function wholeText(a: Approval): string {
  if (a.plan) {
    const steps = a.plan.actions.map((x, i) => `${i + 1}. ${planLine(x)}`);
    return [a.summary?.trim() || a.title, ...steps].join('\n');
  }
  return (a.summary?.trim() || a.detail || a.title).trim();
}

const planLine = (x: PlanAction) =>
  [`${x.summary} · ${x.target}`, x.text ? `“${x.text}”` : ''].filter(Boolean).join(' ');

export interface ApprovalNotice {
  identifier: string;
  title: string;
  subtitle?: string;
  body: string;
  categoryIdentifier: CategoryId;
  /** Ids only. */
  data: { agentId: string; messageId: string; requestId: string; kind: 'approval' };
}

/**
 * The notification for a card, or null when there shouldn't be one (not
 * pending, a muted or hidden agent). Pure: every rule here is tested.
 */
export function approvalNotice(
  agent: Pick<Agent, 'id' | 'name' | 'muted' | 'hidden'>,
  message: AgentMessage
): ApprovalNotice | null {
  const a = message.approval;
  if (message.kind !== 'approval' || !a || a.status !== 'pending') return null;
  if (agent.muted || agent.hidden) return null;
  const data = {
    agentId: agent.id,
    messageId: message.id,
    requestId: a.requestId,
    kind: 'approval' as const,
  };
  const base = { identifier: `approval:${message.id}`, title: agent.name, data };
  // Keys and logins: the name of what it wants, never a field or a value.
  if (a.secret || a.login) {
    return {
      ...base,
      body: `${clip(redact(askingLine(a)).text)}. Open the app to answer.`,
      categoryIdentifier: CATEGORY.review,
    };
  }
  const whole = redact(wholeText(a));
  const actionable = !opensOnly(a) && answersInPlace(message) && !whole.masked;
  if (actionable) {
    return {
      ...base,
      subtitle: redact(a.title).text,
      body: clip(whole.text),
      categoryIdentifier: categoryOf(a),
    };
  }
  return {
    ...base,
    subtitle: redact(a.title).text,
    body: clip(redact(askingLine(a)).text),
    categoryIdentifier: CATEGORY.review,
  };
}

// ---- Answering ------------------------------------------------------------------

/** What tapping a button means. Null: a plain tap (or Review), which opens the app. */
export function answerOf(actionIdentifier: string): boolean | null {
  if (actionIdentifier === ACTION.allow) return true;
  if (actionIdentifier === ACTION.deny) return false;
  return null;
}

export interface AnswerDeps {
  /** Resolves true once the Mac is answering, false if it isn't within the wait. */
  waitLive: () => Promise<boolean>;
  answer: (agentId: string, requestId: string, allow: boolean) => Promise<unknown>;
  /** The Mac's refusal in a sentence ("That request was already answered."). */
  describe: (e: unknown) => string;
  /** Tell the user it didn't land, with the card to open. */
  tell: (target: Target, body: string) => Promise<void>;
  /** Take back this card's notification once answered. */
  dismiss: (agentId: string, messageId: string) => Promise<void>;
}

export type AnswerOutcome = 'answered' | 'refused' | 'unreachable';

/** Not answered: the Mac couldn't be reached in time. */
export const UNREACHABLE = 'Your Mac didn’t answer, so nothing was sent. Open to answer it.';

/**
 * Allow or Deny from a notification. The Mac re-checks everything: the
 * card must still be waiting and this phone allowed to answer it.
 */
export async function answerFromAlert(
  target: { agentId: string; messageId?: string; requestId?: string },
  allow: boolean,
  deps: AnswerDeps
): Promise<AnswerOutcome> {
  const back: Target = {
    agentId: target.agentId,
    ...(target.messageId ? { messageId: target.messageId } : {}),
    kind: 'approval',
  };
  if (!target.requestId) {
    await deps.tell(back, UNREACHABLE);
    return 'unreachable';
  }
  if (!(await deps.waitLive())) {
    await deps.tell(back, UNREACHABLE);
    return 'unreachable';
  }
  try {
    await deps.answer(target.agentId, target.requestId, allow);
  } catch (e) {
    await deps.tell(back, `Not ${allow ? 'allowed' : 'denied'} from here: ${deps.describe(e)}`);
    return 'refused';
  }
  if (target.messageId) await deps.dismiss(target.agentId, target.messageId);
  return 'answered';
}

/** The request id a response's notification carries, if any. */
export function requestIdOf(request: Notifications.NotificationRequest | undefined) {
  const v: unknown = request?.content.data?.requestId;
  return typeof v === 'string' && v ? v : undefined;
}
