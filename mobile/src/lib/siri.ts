/**
 * Siri and Shortcuts: "Tell <app>…", "Ask <app>…", or "Tell <agent> in
 * <app>…" (and the same action in Shortcuts, so on the Action button). Siri
 * asks for the words, opens the app, and the app sends them as you'd have
 * typed them: to the agent you named, else the Chief of Staff.
 *
 * The intent and its phrases are Swift in the app target
 * (`mobile/app-intents/`, compiled in by Expo inline modules and
 * expo-app-intents, which Apple's metadata extraction needs). The intent only
 * records the request (`AppIntentDispatcher`) and opens the app; this file
 * sends it. There is no URL for this on purpose: a link any app or page could
 * open must never send as you, so only the system's own intent runner, from
 * something you said or a shortcut you set up, gets here.
 *
 * The agents' names are published to the system as a catalog
 * (`publishAgents`), so Siri can match "Tell Inbox…". Names only: nothing
 * else about an agent leaves the app, and the catalog is in the app's own
 * storage on this phone.
 *
 * Delivery is at least once (the system keeps the request until it's
 * removed), so each request sends with a `clientId` made from its id: a
 * replay after the app died mid-way is the same message to the Mac, which
 * returns the original rather than sending it twice.
 */

import type { Agent } from '@shipstudio/companion-protocol';

/** The name the Swift intent dispatches (TellAgentIntent.swift). */
export const TELL_AGENT = 'tellAgent';
/** The entity kind the Swift query reads (AgentEntity.swift). */
export const AGENT_KIND = 'agent';

export interface Invocation {
  id: string;
  name: string;
  params: Record<string, unknown>;
}

export type SiriPlan =
  /** Send these words to this agent, and open its chat. */
  | { kind: 'send'; agentId: string; text: string; clientId: string }
  /** Can't be done, ever: say why and let it go. */
  | { kind: 'drop'; reason: string }
  /** Not this app's request (another intent): leave it for whoever handles it. */
  | { kind: 'skip' };

/** The clientId a request sends with, the same on every replay. */
export const siriClientId = (invocationId: string) => `siri-${invocationId}`;

type TeamAgent = Pick<Agent, 'id' | 'name' | 'isMain' | 'hidden'>;

/** What to do with one request, from the team as it is now. */
export function planSiriRequest(invocation: Invocation, team: readonly TeamAgent[]): SiriPlan {
  if (invocation.name !== TELL_AGENT) return { kind: 'skip' };
  const raw = invocation.params.text;
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { kind: 'drop', reason: 'Siri passed no words, so nothing was sent.' };
  const id = invocation.params.agentId;
  const named = typeof id === 'string' && id ? id : null;
  const agent = named ? team.find((a) => a.id === named) : team.find((a) => a.isMain);
  if (!agent) {
    const who = typeof invocation.params.agentName === 'string' && invocation.params.agentName;
    return {
      kind: 'drop',
      reason: named
        ? `${who || 'That agent'} isn’t on your team any more, so nothing was sent.`
        : 'Your team isn’t here yet, so nothing was sent.',
    };
  }
  return { kind: 'send', agentId: agent.id, text, clientId: siriClientId(invocation.id) };
}

/** The catalog Siri matches agent names against: every agent you can talk to, by name. */
export function agentCatalog(team: readonly TeamAgent[]) {
  return team
    .filter((a) => !a.hidden && a.name.trim())
    .map((a) => ({
      id: a.id,
      title: a.name.trim(),
      ...(a.isMain ? { subtitle: 'Chief of Staff', synonyms: ['Chief', 'Chief of Staff'] } : {}),
    }));
}
