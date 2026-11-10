/** One conversation, full screen (see components/ChatView.tsx), in its agent's colour. */

import { useLocalSearchParams } from 'expo-router';
import { ChatView } from '../../components/ChatView';
import { AgentAccent } from '../../lib/accent';

export default function Chat() {
  const { id, at, conversation, compose, notice } = useLocalSearchParams<{
    id: string;
    at?: string;
    /** The conversation `at` was said in (a search hit). */
    conversation?: string;
    compose?: string;
    /** Said once on opening: what a share couldn't bring along. */
    notice?: string;
  }>();
  return (
    <AgentAccent agentId={id}>
      <ChatView id={id} at={at} conversation={conversation} compose={compose === '1'} notice={notice} />
    </AgentAccent>
  );
}

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../../components/ScreenError';
