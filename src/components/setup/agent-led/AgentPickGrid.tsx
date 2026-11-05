/**
 * The engine picker: one card per engine Agents can run on (Claude Code,
 * Codex). Clicking a card enters that engine's install → sign-in flow. Cards
 * say what clicking does next, from what's already detected on the machine
 * ("Ready →", "Sign in →", "Install & sign in →"), so every card reads as
 * something to press rather than a status to worry about.
 *
 * Only engines that can run Agents are offered: picking one that can't
 * (Cursor, Opencode, a bare terminal) used to finish onboarding into an app
 * whose first screen said its engine wasn't installed.
 */

import { ReactNode } from 'react';
import { SetupItem } from '../../../lib/setup';
import { isEnginePairReady, type AgentsEngineBinaryId } from '../../../lib/agentOnboarding';
import { ClaudeIcon, CodexIcon, ArrowRightIcon } from '@/components/icons';

/** Card key: the engine's setup binary id. */
export type AgentCardKey = AgentsEngineBinaryId;

interface CardDef {
  key: AgentCardKey;
  name: string;
  description: string;
  /** The paid plan it signs in with, so nobody picks blind. No prices: they change. */
  account: string;
  /** The one to pick if you don't know which. */
  recommended?: boolean;
  icon: ReactNode;
}

const CARDS: CardDef[] = [
  {
    key: 'claude',
    name: 'Claude Code',
    description: 'Claude, by Anthropic',
    account: 'Uses a Claude Pro or Max plan',
    recommended: true,
    icon: <ClaudeIcon size={28} />,
  },
  {
    key: 'codex',
    name: 'Codex',
    description: 'GPT, by OpenAI',
    account: 'Uses a ChatGPT Plus or Pro plan',
    icon: <CodexIcon size={28} />,
  },
];

/** Detected state of one engine, for the card badge. */
function detectionState(items: SetupItem[], key: AgentCardKey): 'ready' | 'installed' | 'missing' {
  if (isEnginePairReady(items, key)) return 'ready';
  if (items.find((i) => i.id === key)?.status === 'ready') return 'installed';
  return 'missing';
}

const STATUS_LABELS: Record<'ready' | 'installed' | 'missing', string> = {
  ready: 'Ready',
  installed: 'Sign in',
  missing: 'Install & sign in',
};

interface AgentPickGridProps {
  items: SetupItem[];
  onSelect: (key: AgentCardKey) => void;
  disabled?: boolean;
}

export function AgentPickGrid({ items, onSelect, disabled }: AgentPickGridProps) {
  return (
    <div className="agent-pick-grid" role="list">
      {CARDS.map((card) => {
        const state = detectionState(items, card.key);
        return (
          <button
            key={card.key}
            type="button"
            role="listitem"
            className={`agent-pick-card ${state === 'ready' ? 'detected-ready' : ''}`}
            onClick={() => onSelect(card.key)}
            disabled={disabled}
          >
            {card.recommended && <span className="agent-pick-card-badge">Recommended</span>}
            <span className="agent-pick-card-icon">{card.icon}</span>
            <span className="agent-pick-card-name">{card.name}</span>
            <span className="agent-pick-card-desc">{card.description}</span>
            <span className="agent-pick-card-account">{card.account}</span>
            <span className={`agent-pick-card-status ${state}`}>
              {STATUS_LABELS[state]}
              <ArrowRightIcon size={12} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
