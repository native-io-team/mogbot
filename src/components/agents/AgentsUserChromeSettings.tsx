/**
 * Settings → Chrome → "Your Chrome": the switch (off until turned on), then
 * the two things it needs, each read back from the Mac: Chrome can reach
 * this app (the native host), and the extension is in Chrome and connected.
 * Until the Web Store listing exists the extension is added unpacked.
 *
 * @module components/agents/AgentsUserChromeSettings
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { CheckIcon } from '@/components/icons';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { Row, Toggle } from './AgentSettingsRows';
import { useOptionalToast } from '../../contexts/ToastContext';
import { useAsyncState } from '../../hooks/useAsyncState';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { usePolling } from '../../hooks/usePolling';
import { takeSettingsSectionRequest } from '../../lib/settings';
import { POLICY_EVENT } from '../../lib/agentPolicy';
import {
  USER_CHROME_CONNECTED,
  USER_CHROME_TITLE,
  addUserChromeFromStore,
  browserLabel,
  currentStep,
  extensionLine,
  getUserChromeStatus,
  managedAdvice,
  openChromeExtensionsPage,
  openChromeProfile,
  PERSONAL_PROFILE_STEPS,
  routeLine,
  setUserChromeEnabled,
  setupSteps,
  showUserChromeExtension,
  userChromeLine,
  type SetupStepId,
  type UserChromeStatus,
} from '../../lib/userChrome';

type Act = { kind: 'read' } | { kind: 'switch'; on: boolean };

/** A step's number, or a tick once it's done. */
function StepMark({ n, done }: { n?: number; done: boolean }) {
  return (
    <span
      className={`user-chrome-step__mark${done ? ' user-chrome-step__mark--done' : ''}`}
      role="img"
      aria-label={done ? 'Done' : `Step ${n}`}
    >
      {done ? <CheckIcon size={12} /> : n}
    </span>
  );
}

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

  // The extension appeared while this was open (Load unpacked just now):
  // say so, once, rather than leaving a row to change quietly.
  const connected = !!status?.enabled && status.browsers.length > 0;
  const waiting = useRef(false);
  useEffect(() => {
    if (!status) return;
    if (status.enabled && !connected) waiting.current = true;
    else if (connected && waiting.current) {
      waiting.current = false;
      showToast(USER_CHROME_CONNECTED, 'success');
    } else waiting.current = false;
  }, [status, connected, showToast]);

  const { copy, isCopied } = useCopyToClipboard({
    onCopy: () => showToast('Folder path copied.', 'success'),
    onError,
  });

  // "Developer mode is greyed out": what the app can't see for itself.
  const [reported, setReported] = useState(false);
  const advice = status ? managedAdvice(status, reported) : null;
  const openProfile = useCallback(
    (dir?: string) => () =>
      void openChromeProfile(dir).catch((e: unknown) =>
        showToast(e instanceof Error ? e.message : String(e), 'error')
      ),
    [showToast]
  );

  const steps = status?.enabled ? setupSteps(status) : [];
  const current = currentStep(steps);
  // Only the step to do now carries buttons; the rest are a line each.
  const stepActions = (id: SetupStepId): ReactNode => {
    if (!status) return null;
    const openPage = (
      <Button
        key="open"
        variant={id === 'developerMode' ? 'default' : 'secondary'}
        onClick={tryIt(openChromeExtensionsPage)}
      >
        Open Chrome’s extensions
      </Button>
    );
    switch (id) {
      case 'host':
        return (
          <span className="settings-row-actions">
            <Button variant="secondary" onClick={() => run({ kind: 'switch', on: true })}>
              Set it up again
            </Button>
          </span>
        );
      case 'developerMode':
        return <span className="settings-row-actions">{openPage}</span>;
      case 'load':
        if (status.steps.turnedOff) return <span className="settings-row-actions">{openPage}</span>;
        return (
          <span className="settings-row-actions">
            {status.extensionDir && (
              <>
                <Button variant="default" onClick={tryIt(showUserChromeExtension)}>
                  Show the folder in Finder
                </Button>
                <Button variant="secondary" onClick={() => void copy(status.extensionDir!)}>
                  {isCopied ? 'Copied' : 'Copy folder path'}
                </Button>
              </>
            )}
            {openPage}
          </span>
        );
      default:
        return null;
    }
  };

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
        {status?.route && <Row label="Agents use now" description={routeLine(status.route)} />}
        {status?.enabled && status.browsers.length === 0 && !status.webStoreUrl && (
          <div className="settings-row-steps" data-testid="user-chrome-steps">
            {advice && (
              <Row
                label="Chrome is managed by your work"
                description={
                  advice.everyProfile ? advice.line : `${advice.line} ${PERSONAL_PROFILE_STEPS}`
                }
                stacked={!advice.everyProfile}
              >
                {!advice.everyProfile && (
                  <span className="settings-row-actions" data-testid="user-chrome-profiles">
                    {advice.personal && (
                      <Button variant="secondary" onClick={openProfile(advice.personal.dir)}>
                        Open “{advice.personal.name}”
                      </Button>
                    )}
                    <Button variant="secondary" onClick={openProfile()}>
                      Open a new Chrome profile
                    </Button>
                  </span>
                )}
              </Row>
            )}
            <ol className="user-chrome-steps" aria-label="Steps to connect your Chrome">
              {steps.map((step, i) => {
                const now = step === current;
                const actions = now ? stepActions(step.id) : null;
                return (
                  <li
                    key={step.id}
                    className={`user-chrome-step${step.done ? ' user-chrome-step--done' : ''}${now ? ' user-chrome-step--current' : ''}`}
                    data-step={step.id}
                    aria-current={now ? 'step' : undefined}
                  >
                    <Row
                      label={
                        <span className="user-chrome-step__title">
                          <StepMark n={i + 1} done={step.done} />
                          {step.title}
                        </span>
                      }
                      description={step.line}
                      stacked={!!actions}
                    >
                      {actions}
                    </Row>
                  </li>
                );
              })}
            </ol>
            {!advice && current && current.id !== 'connect' && (
              <p className="settings-row-description">
                <TextButton onClick={() => setReported(true)}>
                  Developer mode greyed out in Chrome?
                </TextButton>
              </p>
            )}
          </div>
        )}
        {status?.enabled && status.browsers.length === 0 && status.webStoreUrl && (
          <Row label="Add the extension to Chrome" description={extensionLine(status)}>
            <Button variant="secondary" onClick={tryIt(addUserChromeFromStore)}>
              Add to Chrome…
            </Button>
          </Row>
        )}
        {status?.enabled && status.browsers.length > 0 && (
          <div className="settings-row-steps" data-testid="user-chrome-connected">
            {status.browsers.map((b, i) => (
              <Row
                key={b.profileId}
                label={
                  <span className="user-chrome-step__title">
                    <StepMark done />
                    {browserLabel(b, i)}
                  </span>
                }
                description={
                  status.updateNeeded
                    ? `Connected (extension ${b.extensionVersion}; this app ships a newer one: reload it in Chrome’s extensions page).`
                    : `Connected (extension ${b.extensionVersion}). Agents use it from their next message.`
                }
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
