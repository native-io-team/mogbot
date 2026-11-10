/**
 * "Already have agents in another assistant?" — asked once, at the top of
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
import {
  IMPORT_CHOICE_BRING,
  IMPORT_CHOICE_DECLINE,
  IMPORT_CHOICE_NOTE,
  IMPORT_CHOICE_TITLE,
} from '../../../packages/companion-protocol/src/cardWords';

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
      title={IMPORT_CHOICE_TITLE}
      note={IMPORT_CHOICE_NOTE}
      actions={
        <>
          <Button variant="secondary" size="compact" disabled={saving} onClick={decline}>
            {IMPORT_CHOICE_DECLINE}
          </Button>
          <Button
            variant="strong"
            size="compact"
            disabled={saving}
            onClick={onImport}
            data-import-choice-bring
          >
            {IMPORT_CHOICE_BRING}
          </Button>
        </>
      }
    />
  );
}
