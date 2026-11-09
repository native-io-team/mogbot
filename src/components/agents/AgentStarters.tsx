/**
 * A new agent's first open: under its welcome, the three tasks the Mac chose
 * from what it can already reach (`agents/starters.rs`). One tap sends the
 * words as the user's message; the Mac drops them once the user has said
 * anything. The ask to connect an app, when there is one, is one of the three.
 */

import type { AgentStarter } from '../../lib/agents';
import { Button } from '../primitives/Button';

export function AgentStarters({
  starters,
  onSend,
}: {
  starters: readonly AgentStarter[];
  onSend: (text: string) => void;
}) {
  return (
    <div className="agent-chat__starters" data-first-open>
      {starters.map((s) => (
        <Button
          key={s.text}
          tabIndex={0}
          variant="secondary"
          data-connect={s.connect || undefined}
          onClick={() => onSend(s.text)}
        >
          {s.text}
        </Button>
      ))}
    </div>
  );
}
