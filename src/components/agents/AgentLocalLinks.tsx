/**
 * Links an agent wrote to a server on this Mac (`localLinks`, taken out of
 * the reply's text by the Mac). One the app knows serves a project is a
 * chip with Preview, which opens it in the pane beside the chat; anything
 * else is a plain "Running on this Mac" chip that opens in the browser here
 * (it would be a dead link anywhere else).
 *
 * @module components/agents/AgentLocalLinks
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { DesktopIcon, ExternalLinkIcon, GlobeIcon } from '@/components/icons';
import { TextButton } from '../primitives/TextButton';
import { useAgentPreview } from './AgentPreviewContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { folderName, type AgentMessage, type LocalLink } from '../../lib/agents';

/** "localhost:3400": where an unknown server is, never more than that. */
export function localWhere(link: LocalLink): string {
  try {
    return new URL(link.url).host;
  } catch {
    return `localhost:${link.port}`;
  }
}

export function LocalLinks({ message }: { message: AgentMessage }) {
  const preview = useAgentPreview();
  const { showToast } = useOptionalToast();
  const links = message.localLinks ?? [];
  if (links.length === 0) return null;
  const openHere = (url: string) =>
    Promise.resolve()
      .then(() => openUrl(url))
      .catch((error: unknown) => showToast(formatCommandError(asCommandError(error)), 'error'));
  return (
    <ul className="agent-local-links" aria-label="Running on this Mac">
      {links.map((link, i) => {
        const known = Boolean(link.path) && preview;
        const where = link.project
          ? link.copy
            ? `A copy of ${folderName(link.project)}`
            : folderName(link.project)
          : null;
        return (
          <li key={`${i}:${link.url}`} className="agent-local-link" data-known={known || undefined}>
            <span className="agent-local-link__glyph" aria-hidden>
              {known ? <GlobeIcon size={14} /> : <DesktopIcon size={14} />}
            </span>
            <span className="agent-local-link__text">
              <span className="agent-local-link__label">{link.label}</span>
              <span className="agent-local-link__meta">
                {known && where
                  ? where
                  : link.label === localWhere(link)
                    ? 'Running on this Mac'
                    : `Running on this Mac · ${localWhere(link)}`}
              </span>
            </span>
            {known ? (
              <TextButton
                tabIndex={0}
                leftIcon={<GlobeIcon size={12} />}
                onClick={() => preview.open(message.agentId, message.id, { link: i })}
              >
                Preview
              </TextButton>
            ) : (
              <TextButton
                tabIndex={0}
                leftIcon={<ExternalLinkIcon size={12} />}
                onClick={() => void openHere(link.url)}
                title={`Open ${link.url} in your browser`}
              >
                Open
              </TextButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}
