/**
 * The bar above the Chief's composer while another assistant is importing
 * its agents over the connector (`agents/connector.rs`): who, how far, and
 * Stop. Gone when there's no conversation going.
 *
 * @module components/agents/ImportTalkBar
 */

import { TextButton } from '../primitives/TextButton';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { stopImportTalk } from '../../lib/agents';
import { listOf } from './ImportParts';
import { useImportTalk } from './ImportConnectorPanel';

export function ImportTalkBar({ chief }: { chief: string }) {
  const talk = useImportTalk();
  const { showToast } = useOptionalToast();
  if (!talk || talk.state !== 'active') return null;
  const so = talk.agents.length
    ? `${listOf(talk.agents)} ${talk.agents.length === 1 ? 'is' : 'are'} here so far`
    : `${chief} is asking about its agents`;
  return (
    <p className="agent-import-talk" role="status" data-testid="agent-import-talk">
      <span className="agent-import-talk__dot" aria-hidden />
      <span className="agent-import-talk__text">
        <strong>Importing from {talk.source}</strong> over the connector · {so}
      </span>
      <TextButton
        onClick={() => {
          stopImportTalk().catch((e: unknown) =>
            showToast(formatCommandError(asCommandError(e)), 'error')
          );
        }}
      >
        Stop import
      </TextButton>
    </p>
  );
}
