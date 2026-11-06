/**
 * "Bring your agents from another assistant?" — asked once, at the top of
 * the Chief's chat, for an install that never answered it (onboarding's last
 * step asks everyone new). Once it's answered (an import brought something
 * across, or "No thanks, start fresh"), import lives in the background: ⌘K,
 * the Chief, Settings → Agents and the phone's ⋯ menu.
 *
 * The answer is the Mac's (`agents::import_choice`), so the desk and the
 * phone ask, and stop asking, together. Hidden while an import is going.
 *
 * @module components/agents/ImportChoiceCard
 */

import { useState } from 'react';
import { Button } from '../primitives/Button';
import { DownloadIcon } from '@/components/icons';
import { AgentCard } from './AgentCard';
import { useImportGate } from './ImportConnectorPanel';
import { useAgentsSelector, refreshAgents } from '../../lib/agentsStore';
import { setImportChoice } from '../../lib/agents';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';

export function ImportChoiceCard({ onImport }: { onImport: () => void }) {
  const choice = useAgentsSelector((s) => s.importChoice);
  const { talk } = useImportGate();
  const { showToast } = useOptionalToast();
  const [saving, setSaving] = useState(false);
  // Null: a Mac that doesn't say, which never asks.
  if (choice !== 'undecided' || talk) return null;

  const decline = () => {
    setSaving(true);
    setImportChoice('declined')
      .then(() => refreshAgents())
      .catch((e: unknown) => showToast(formatCommandError(asCommandError(e)), 'error'))
      .finally(() => setSaving(false));
  };

  return (
    <AgentCard
      className="agent-import-choice"
      data-testid="agent-import-choice"
      icon={<DownloadIcon size={14} />}
      title="Bring your agents from another assistant?"
      note="From Grok, ChatGPT, Claude or anything else that runs agents for you. Each comes with its instructions, routines and memory, and nothing is created until you say so."
      actions={
        <>
          <Button variant="secondary" size="compact" disabled={saving} onClick={decline}>
            No thanks, start fresh
          </Button>
          <Button
            variant="strong"
            size="compact"
            disabled={saving}
            onClick={onImport}
            data-import-choice-bring
          >
            Bring my agents
          </Button>
        </>
      }
    />
  );
}
