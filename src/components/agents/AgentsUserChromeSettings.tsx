/**
 * Settings → Agents → "Your Chrome": the switch (off until turned on), then
 * the two things it needs, each read back from the Mac: Chrome can reach
 * this app (the native host), and the extension is in Chrome and connected.
 * Until the Web Store listing exists the extension is added unpacked.
 *
 * @module components/agents/AgentsUserChromeSettings
 */

import { useCallback, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Button } from '../primitives/Button';
import { Row, Toggle } from './AgentSettingsRows';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { POLICY_EVENT } from '../../lib/agentPolicy';
import {
  USER_CHROME_TITLE,
  addUserChromeFromStore,
  browserLabel,
  extensionLine,
  getUserChromeStatus,
  hostLine,
  openChromeExtensionsPage,
  setUserChromeEnabled,
  showUserChromeExtension,
  userChromeLine,
  type UserChromeStatus,
} from '../../lib/userChrome';

type Act = { kind: 'read' } | { kind: 'switch'; on: boolean };

const act = (a: Act): Promise<UserChromeStatus> =>
  a.kind === 'switch' ? setUserChromeEnabled(a.on) : getUserChromeStatus();

export function AgentsUserChromeSettings() {
  const { showToast } = useOptionalToast();
  const onError = useCallback((e: Error) => showToast(e.message, 'error'), [showToast]);
  // One call at a time, in the order asked. Otherwise a read the poll (or a
  // window focus) started just before the switch was pressed answers after
  // it, with the old state, and flips the switch back.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback((a: Act) => {
    const next = queue.current.catch(() => {}).then(() => act(a));
    queue.current = next;
    return next;
  }, []);
  const { data: status, execute } = useAsyncState<UserChromeStatus, [Act]>(serial, { onError });
  const run = useCallback((a: Act) => void execute(a).catch(() => {}), [execute]);
  const tryIt = useCallback(
    (f: () => Promise<void>) => () =>
      void f().catch((e: unknown) =>
        showToast(e instanceof Error ? e.message : String(e), 'error')
      ),
    [showToast]
  );

  useEffect(() => {
    run({ kind: 'read' });
    const onFocus = () => run({ kind: 'read' });
    window.addEventListener('focus', onFocus);
    // Chat turns it on (on a card) or off (`propose_settings_change`).
    let off: (() => void) | undefined;
    void listen(POLICY_EVENT, onFocus)
      .then((u) => (off = u))
      .catch(() => {});
    return () => {
      window.removeEventListener('focus', onFocus);
      off?.();
    };
  }, [run]);

  // Opened from ⌘K "Let agents use your Chrome…": scrolled to here.
  const ref = useRef<HTMLElement>(null);
  const loaded = !!status;
  useEffect(() => {
    if (loaded && takeSettingsSectionRequest('agent-user-chrome')) {
      ref.current?.scrollIntoView?.({ block: 'start' });
    }
  }, [loaded]);

  // While it's on and nothing is connected yet, watch for the extension.
  usePolling(() => execute({ kind: 'read' }), {
    intervalMs: 3000,
    enabled: !!status?.enabled && status.browsers.length === 0,
  });

  if (status && !status.supported) return null;
  return (
    <section ref={ref} className="settings-group" aria-labelledby="agents-settings-user-chrome">
      <h3 className="settings-group__title" id="agents-settings-user-chrome">
        {USER_CHROME_TITLE}
      </h3>
      <div className="settings-section">
        <Row label="Let agents use your Chrome" description={userChromeLine(status)}>
          <Toggle
            on={status?.enabled ?? false}
            label="Let agents use your Chrome"
            onChange={(on) => run({ kind: 'switch', on })}
          />
        </Row>
        {status?.enabled && (
          <div className="settings-row-steps" data-testid="user-chrome-steps">
            {!status.chromeInstalled && (
              <Row
                label="Google Chrome"
                description="Not done yet. Install Google Chrome on this Mac first."
              />
            )}
            <Row label="Chrome can reach this app" description={hostLine(status.host)} />
            <Row label="Add the extension to Chrome" description={extensionLine(status)}>
              {status.browsers.length === 0 &&
                (status.webStoreUrl ? (
                  <Button variant="secondary" onClick={tryIt(addUserChromeFromStore)}>
                    Add to Chrome…
                  </Button>
                ) : (
                  <span className="settings-row-actions">
                    <Button variant="secondary" onClick={tryIt(openChromeExtensionsPage)}>
                      Open Chrome’s extensions
                    </Button>
                    {status.extensionDir && (
                      <Button variant="secondary" onClick={tryIt(showUserChromeExtension)}>
                        Show the folder
                      </Button>
                    )}
                  </span>
                ))}
            </Row>
            {status.browsers.map((b, i) => (
              <Row
                key={b.profileId}
                label={browserLabel(b, i)}
                description={
                  status.updateNeeded
                    ? `Connected (extension ${b.extensionVersion}; this app ships a newer one: reload it in Chrome’s extensions page).`
                    : `Connected (extension ${b.extensionVersion}).`
                }
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
