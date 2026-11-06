/**
 * Settings → Agents: whether a preview that stops by itself wakes the agent
 * that owns it (`lib/agentPreviewFix.ts`). Off, the pane offers "Ask <agent>
 * to fix it" instead.
 *
 * @module components/agents/AgentPreviewFixSetting
 */
import { useState } from 'react';
import { Row, Toggle } from './AgentSettingsRows';
import { useInvoke } from '../../hooks/useInvoke';
import { useOptionalToast } from '../../contexts/ToastContext';
import { setFixPreviews } from '../../lib/agentPreviewFix';
import { asCommandError, formatCommandError } from '../../lib/errors';

export function AgentPreviewFixSetting() {
  const { showToast } = useOptionalToast();
  const { data } = useInvoke<boolean>('get_agents_fix_previews', { immediate: true });
  const [chosen, setChosen] = useState<boolean | null>(null);
  const on = chosen ?? data;
  if (on === null || on === undefined) return null;
  const change = (next: boolean) => {
    setChosen(next);
    setFixPreviews(next).catch((e: unknown) => {
      setChosen(!next);
      showToast(formatCommandError(asCommandError(e)), 'error');
    });
  };
  return (
    <Row
      label="Fix stopped previews"
      description="When an agent’s preview stops by itself, that agent is told and fixes it."
    >
      <Toggle on={on} label="Fix stopped previews" onChange={change} />
    </Row>
  );
}
