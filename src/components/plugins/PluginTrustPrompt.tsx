/**
 * "This project wants to load plugin X — Allow / Don't load".
 *
 * A project's `.shipstudio/plugins/registry.json` travels with the repo, so
 * it can only ask. Until the user allows a plugin here (approving that exact
 * bundle, by path and SHA-256 — `plugin_trust.rs`), it isn't loaded. This
 * is a small card under the Plugins control, not a modal: nothing is
 * blocked while it waits, and "Don't load" is remembered for that bundle.
 *
 * @module components/plugins/PluginTrustPrompt
 */

import { useState } from 'react';
import { Button } from '../primitives/Button';
import { approvePlugin, declinePlugin, type PluginInfo } from '../../lib/plugins';
import { asCommandError, formatCommandError } from '../../lib/errors';

interface Props {
  projectPath: string;
  /** Not yet approved as they are now; the first is asked about. */
  pending: PluginInfo[];
  /** Load (or skip) again once the user has answered. */
  onDecided: () => Promise<void> | void;
}

export function PluginTrustPrompt({ projectPath, pending, onDecided }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plugin = pending[0];
  const sha256 = plugin?.trust?.sha256;
  if (!plugin || !sha256) return null;
  const changed = plugin.trust?.state === 'changed';
  const id = plugin.manifest.id;

  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (allow) await approvePlugin(projectPath, id, sha256);
      else await declinePlugin(projectPath, id, sha256);
      await onDecided();
    } catch (e) {
      setError(formatCommandError(asCommandError(e)));
      // It changed since it was shown: show the new one.
      await onDecided();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plugin-trust-prompt" role="region" aria-labelledby="plugin-trust-title">
      {/* The name and repo come from the project's own files, which anyone
          with push access controls: they are what the plugin says about
          itself, never shown as fact. */}
      <p id="plugin-trust-title" className="plugin-trust-title">
        {changed
          ? `A plugin you allowed here (“${plugin.manifest.name}”) changed since`
          : `This project wants to load a plugin that calls itself “${plugin.manifest.name}”`}
      </p>
      <p className="plugin-trust-hint">
        A plugin runs code inside the app, with access to this project. Only allow ones you trust.
      </p>
      <p className="plugin-trust-source">
        <span className="plugin-trust-label">From</span>
        <code title={plugin.trust?.bundlePath}>{plugin.trust?.bundlePath}</code>
      </p>
      {plugin.source_url && (
        <p className="plugin-trust-source">
          <span className="plugin-trust-label">Says it’s from</span>
          <code>{plugin.source_url}</code>
        </p>
      )}
      {error && (
        <p className="plugin-trust-error" role="alert">
          {error}
        </p>
      )}
      <div className="plugin-trust-actions">
        {pending.length > 1 && <span className="plugin-trust-count">1 of {pending.length}</span>}
        <Button
          size="compact"
          variant="secondary"
          disabled={busy}
          onClick={() => void answer(false)}
        >
          Don’t load
        </Button>
        <Button size="compact" variant="primary" disabled={busy} onClick={() => void answer(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}
