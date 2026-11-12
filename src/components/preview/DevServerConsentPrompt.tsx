import { useState } from 'react';
import { Button } from '../primitives/Button';
import {
  approveDevServer,
  consentFiles,
  consentLines,
  devServerConsentStore,
  getDevServerConsent,
  type PendingDevServerConsent,
} from '../../lib/devServerConsent';
import { asCommandError, formatCommandError } from '../../lib/errors';
import { YOUR_COMPUTER } from '../../lib/computer';

interface Props {
  projectPath: string;
  pending: PendingDevServerConsent;
}

/**
 * Asks once before a project's own commands run as its dev server, and again
 * when they change. Shown in place of the preview, like the install prompt.
 */
export function DevServerConsentPrompt({ projectPath, pending }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { consent } = pending;
  const lines = consentLines(consent.surface);
  const files = consentFiles(consent.surface);
  const changed = consent.state === 'changed';

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await approveDevServer(projectPath, consent.fingerprint);
      devServerConsentStore.clear(projectPath);
      await pending.resume();
    } catch (e) {
      // Changed again since it was shown: show the new version instead.
      const fresh = await getDevServerConsent(projectPath).catch(() => null);
      if (fresh && fresh.fingerprint !== consent.fingerprint) {
        devServerConsentStore.set(projectPath, { ...pending, consent: fresh });
      }
      setError(formatCommandError(asCommandError(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="preview-install-prompt dev-consent" role="region" aria-label="Dev server">
      <h3>{changed ? 'This project changed — Start dev server?' : 'Start the dev server?'}</h3>
      <p className="text-style-hint">
        {changed
          ? `Its commands or config changed since you last started it. Starting it runs them on ${YOUR_COMPUTER}.`
          : `Starting it runs this project’s own commands on ${YOUR_COMPUTER}. Only start projects you trust.`}
      </p>
      {consent.installScriptsPending && (
        <p className="text-style-hint">
          Its dependencies were installed without their install scripts. Starting it runs those
          first.
        </p>
      )}
      {lines.length > 0 ? (
        <ul className="dev-consent-scripts" aria-label="Commands that can run">
          {lines.map((l) => (
            <li key={l.label}>
              <span className="dev-consent-name">{l.label}</span>
              <code>{l.command}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-style-hint">This project defines no scripts.</p>
      )}
      {files.length > 0 && (
        <p className="text-style-hint dev-consent-files">
          Also part of what you’re approving: <code>{files.join(', ')}</code>
        </p>
      )}
      {error && (
        <p className="dev-consent-error" role="alert">
          {error}
        </p>
      )}
      <Button variant="strong" data-allow onClick={() => void start()} disabled={busy}>
        Start dev server
      </Button>
    </div>
  );
}
