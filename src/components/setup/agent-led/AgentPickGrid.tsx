/**
 * The engine picker: one card per engine Agents can run on (Claude Code,
 * Codex, and OpenCode once it is installed here: it runs on whatever
 * providers it is set up with, so it is offered to people who already use
 * it rather than as a first choice). Clicking a card enters that engine's install → sign-in flow. Cards
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
import { ClaudeIcon, CodexIcon, OpencodeIcon, ArrowRightIcon } from '@/components/icons';
import { THIS_COMPUTER } from '../../../lib/computer';

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
  /** Offered only once it is installed on this Mac. */
  ifInstalled?: boolean;
  icon: ReactNode;
}

const CARDS: CardDef[] = [
  {
    key: 'claude',
    name: 'Claude Code',
    description: 'Claude, by Anthropic. Despite the name, it does any job, not only code.',
    account: 'Needs a Claude Pro or Max plan',
    recommended: true,
    icon: <ClaudeIcon size={28} />,
  },
  {
    key: 'codex',
    name: 'Codex',
    description: 'ChatGPT’s models, by OpenAI. It also does any job, not only code.',
    account: 'Needs a ChatGPT Plus or Pro plan',
    icon: <CodexIcon size={28} />,
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    description: `Open source. Runs on the AI providers you set up in it, or models on ${THIS_COMPUTER}.`,
    account: 'Uses a provider you sign in to in OpenCode',
    ifInstalled: true,
    icon: <OpencodeIcon size={28} />,
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
        if (card.ifInstalled && state === 'missing') return null;
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
