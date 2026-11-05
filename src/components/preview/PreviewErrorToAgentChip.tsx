/**
 * The preview's error page asked to send its error to the agent. This chip is
 * the only way that happens: it lives in the app, outside the iframe, shows the
 * exact text, and sends it — as a bracketed prompt the user still submits —
 * only to an agent tab, on the user's click. See lib/previewErrorToAgent.
 */
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import type { CommentAgent } from '../../lib/canvasComments';
import { pickErrorAgent, previewErrorPrompt } from '../../lib/previewErrorToAgent';
import { Button } from '../primitives/Button';

interface PreviewErrorToAgentChipProps {
  error: string;
  agents: CommentAgent[];
  onDismiss: () => void;
}

export function PreviewErrorToAgentChip({
  error,
  agents,
  onDismiss,
}: PreviewErrorToAgentChipProps) {
  const { showToast } = useOptionalToast();
  const target = pickErrorAgent(agents);
  const { isLoading, execute } = useAsyncState(
    async () => {
      if (!target) throw new Error('Open an agent tab first.');
      await target.send(previewErrorPrompt(error));
    },
    {
      onSuccess: () => {
        onDismiss();
        showToast('Added to the agent’s prompt. Press Return there to send it.', 'success');
      },
      onError: (err) => showToast(err.message, 'error'),
    }
  );

  return (
    <div
      className="preview-error-agent-chip"
      role="region"
      aria-live="polite"
      aria-label="Send this error to the agent?"
      data-testid="preview-error-agent-chip"
    >
      <div className="preview-error-agent-chip__title">Send this error to the agent?</div>
      <pre className="preview-error-agent-chip__text">{error}</pre>
      {!target && (
        <div className="preview-error-agent-chip__hint">
          Open an agent tab to send it. Errors are never sent to a plain terminal.
        </div>
      )}
      <div className="preview-error-agent-chip__actions">
        <Button variant="ghost" size="compact" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button
          variant="primary"
          size="compact"
          disabled={!target || isLoading}
          onClick={() => void execute()}
        >
          {target ? `Send to ${target.label}` : 'Send to agent'}
        </Button>
      </div>
    </div>
  );
}
