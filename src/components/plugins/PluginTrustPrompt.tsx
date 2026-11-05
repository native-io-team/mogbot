/**
 * Asks before a project's plugin runs in this app.
 *
 * A project's `.shipstudio/plugins/registry.json` travels with the repo, so
 * a clone, a pull or Ship Studio can put a plugin there. Its code would run
 * inside this app with the project's files and the commands it lists, so
 * nothing loads until the user allows it here; the backend refuses the
 * bundle until then too (`plugin_trust.rs`).
 *
 * Quiet by design: one toast when a project first has something to ask
 * about, and a row in the Plugins menu. The dialog opens only when the user
 * chooses to review — never on its own, never one per plugin.
 *
 * @module components/plugins/PluginTrustPrompt
 */

import { useState } from 'react';
import { ModalFrame } from '../primitives/ModalFrame';
import { Button } from '../primitives/Button';
import { useModal } from '../../contexts/ModalContext';
import { useOptionalToast } from '../../contexts/ToastContext';
import { asCommandError, formatCommandError } from '../../lib/errors';
import type { PluginInfo } from '../../lib/plugins';

interface PluginTrustPromptProps {
  /** Plugins waiting on the user, first one asked about first. */
  pending: PluginInfo[];
  onAllow: (info: PluginInfo) => Promise<void>;
  onDecline: (info: PluginInfo) => void;
}

/** The sentence the dialog and the Plugins menu lead with. */
export function trustQuestion(info: PluginInfo): string {
  return info.trust === 'changed'
    ? `${info.manifest.name} has changed since you allowed it.`
    : `This project wants to load the plugin ${info.manifest.name}.`;
}

export function PluginTrustPrompt({ pending, onAllow, onDecline }: PluginTrustPromptProps) {
  const { isOpen, close } = useModal('pluginTrust');
  const { showToast } = useOptionalToast();
  const [allowing, setAllowing] = useState(false);
  const current = pending[0];

  if (!isOpen || !current) return null;

  const more = pending.length - 1;
  const closeIfLast = () => {
    if (more === 0) close();
  };

  const handleAllow = async () => {
    setAllowing(true);
    try {
      await onAllow(current);
      showToast(`${current.manifest.name} is allowed`, 'success');
      closeIfLast();
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    } finally {
      setAllowing(false);
    }
  };

  const handleDecline = () => {
    onDecline(current);
    closeIfLast();
  };

  return (
    <ModalFrame
      isOpen
      onClose={() => !allowing && close()}
      title="Load this plugin?"
      showCloseButton={false}
      dismissable={!allowing}
    >
      <div className="plugin-trust-body" data-testid="plugin-trust-prompt">
        <div className="confirm-modal-text">
          <p>{trustQuestion(current)}</p>
          <p className="text-style-hint">
            Its code runs inside this app, with access to this project's files and the commands it
            lists. Only allow plugins you expect.
          </p>
          <div className="plugin-trust-source">
            <span className="plugin-trust-source-label">Loads from</span>
            <code className="plugin-trust-source-path">{current.source_path}</code>
            {current.source_url && (
              <>
                <span className="plugin-trust-source-label">Listed source</span>
                <code className="plugin-trust-source-path">{current.source_url}</code>
              </>
            )}
          </div>
          {more > 0 && (
            <p className="text-style-hint">
              {more === 1 ? '1 more plugin is waiting.' : `${more} more plugins are waiting.`}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <Button variant="secondary" onClick={handleDecline} disabled={allowing}>
            Don't load
          </Button>
          <Button variant="primary" onClick={() => void handleAllow()} disabled={allowing}>
            {allowing ? 'Allowing…' : 'Allow'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
