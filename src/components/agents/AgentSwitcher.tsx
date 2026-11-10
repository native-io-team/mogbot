/**
 * Below the compact breakpoint the sidebar is gone, so the header's title is
 * a menu of every agent and Home. Each item's key shows its state (pressed
 * and lit while it works, amber while it needs you) as the list's does, and
 * the one mark beside it is the list's: unread.
 *
 * @module components/agents/AgentSwitcher
 */

import type { ReactNode } from 'react';
import { CheckIcon, ChevronIcon, HomeIcon } from '@/components/icons';
import { Dropdown, DropdownDivider, DropdownItem } from '../primitives/Dropdown';
import { MenuButton } from '../primitives/MenuButton';
import { AgentKey } from './AgentKey';
import { agentKeyState, sortAgents, type Agent } from '../../lib/agents';

interface AgentSwitcherProps {
  agents: Agent[];
  /** The agent on screen, or the what's-in-flight view's id. */
  currentId: string;
  /** What the trigger shows: the current agent's badge and name. */
  title: ReactNode;
  label: string;
  onOpenAgent: (agentId: string) => void;
  onGoHome: () => void;
}

/**
 * The one mark beside an agent's key: unread, a small quiet dot in neutral
 * ink. Everything else is the key's to say: working (pressed, lit,
 * breathing), needs your OK (proud, amber, pulsing), paused at a usage limit
 * (grey, sunk); a turn that didn't finish says so in the row's words and its
 * chat. No loader and no amber or red dot on top of a key: that was three
 * signals stacked on one that already said it.
 */
export function AgentMark({ agent }: { agent: Agent }) {
  if (agent.unread > 0) return <span className="agent-unread-dot" aria-label="Unread" />;
  return null;
}

export function AgentSwitcher({
  agents,
  currentId,
  title,
  label,
  onOpenAgent,
  onGoHome,
}: AgentSwitcherProps) {
  return (
    <Dropdown
      portal
      className="agent-chat__switcher"
      menuClassName="agent-model-menu"
      trigger={(p) => (
        <MenuButton
          {...p}
          tabIndex={0}
          expanded={p['aria-expanded']}
          variant="ghost"
          className="agent-chat__title"
          aria-label={label}
        >
          {title}
          <ChevronIcon
            size={10}
            className={`agent-chat__switcher-chevron${p['aria-expanded'] ? ' chevron-flipped' : ''}`}
          />
        </MenuButton>
      )}
    >
      {sortAgents(agents)
        .filter((a) => !a.hidden || a.id === currentId)
        .map((a) => (
          <DropdownItem
            key={a.id}
            icon={
              <AgentKey
                id={a.id}
                name={a.name}
                color={a.color}
                state={agentKeyState(a)}
                size="sm"
              />
            }
            onSelect={() => onOpenAgent(a.id)}
          >
            <span className="agent-model-menu__label">{a.name}</span>
            <span className="agent-switcher__mark">
              {a.id === currentId ? (
                <CheckIcon size={12} aria-label="Open" />
              ) : (
                <AgentMark agent={a} />
              )}
            </span>
          </DropdownItem>
        ))}
      <DropdownDivider />
      <DropdownItem icon={<HomeIcon size={14} />} onSelect={onGoHome}>
        Home
      </DropdownItem>
    </Dropdown>
  );
}
