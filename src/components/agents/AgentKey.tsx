/**
 * The agent, on a key: what leads the working line while it works
 * (docs/internal/avatars.md, "On a key"). A wide key cap in the site's
 * language, a lit top on a darker side with a hairline ring and a soft drop,
 * faintly tinted with the agent's hue, and its avatar on the cap (the solid
 * one: you're looking at that agent). While it's live the cap is typed on:
 * a tap, a lighter tap, a rest, the top pressing into its side and springing
 * back. Stalled or finishing, it rests.
 *
 * Geometry and colour come from the spec the phone draws from (`TYPING_KEY`,
 * `typingKeyPaint` in packages/companion-protocol/src/avatar.ts); the press
 * is CSS keyframes on one composited layer (agents-work.css), still with
 * Reduce Motion and while the window is hidden.
 *
 * @module components/agents/AgentKey
 */

import type { CSSProperties } from 'react';
import { typingKeyPaint } from '../../../packages/companion-protocol/src/avatar';
import { useResolvedTheme } from '../../lib/theme';
import { AgentAvatar } from './AgentAvatar';

interface AgentKeyProps {
  id: string;
  name: string;
  color: string;
  /** Being typed on (the line is live); otherwise it rests. */
  pressing: boolean;
}

export function AgentKey({ id, name, color, pressing }: AgentKeyProps) {
  const theme = useResolvedTheme();
  const paint = typingKeyPaint(color, theme);
  // Computed per agent and theme from the spec, as the avatar's paint is.
  const style = {
    '--agent-key-top-high': paint.topHigh,
    '--agent-key-top-low': paint.topLow,
    '--agent-key-side': paint.side,
    '--agent-key-highlight': `rgba(255, 255, 255, ${paint.highlight})`,
    '--agent-key-ring': `rgba(0, 0, 0, ${paint.ring})`,
    '--agent-key-shadow': `rgba(0, 0, 0, ${paint.shadow})`,
  } as CSSProperties;
  return (
    <span className="agent-key" data-pressing={pressing || undefined} style={style} aria-hidden>
      <span className="agent-key__top">
        <AgentAvatar
          id={id}
          name={name}
          color={color}
          size="key"
          selected
          mood={pressing ? 'working' : 'idle'}
        />
      </span>
    </span>
  );
}
