/**
 * The first screen: what this is, in a line, and one big button.
 *
 * @module components/setup/flow/SimpleSteps
 */

import { Button } from '../../primitives/Button';
import { AgentAvatar } from '../../agents/AgentAvatar';
import { FlowShell } from './FlowParts';
import { CHIEF_LOOK } from '../../../../packages/companion-protocol/src/avatar';

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <FlowShell
      step="welcome"
      mark={
        <AgentAvatar look={CHIEF_LOOK} name="Chief of Staff" color="white" size="hero" selected />
      }
      title="Your own team of AI agents"
      lede="They run on this Mac, on your own Claude or ChatGPT plan. You talk to one, your Chief of Staff, and anything risky waits for your OK."
      primary={
        <Button variant="primary" size="large" onClick={onNext} autoFocus data-flow-primary>
          Get started
        </Button>
      }
    >
      <p className="flow-note">About five minutes.</p>
    </FlowShell>
  );
}
