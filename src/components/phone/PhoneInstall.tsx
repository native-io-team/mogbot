/**
 * "Install on my phone", inside the Phone panel: choose a route, then — for
 * "Build it on this Mac" — a checklist decided by the app's own checks
 * beside a terminal where Claude Code does the work. Once the app is on the
 * phone, the panel goes straight to pairing.
 *
 * Nothing runs until the user clicks: the checks are read-only, and the agent
 * (or Reinstall's build command) starts only from a button.
 *
 * @module components/phone/PhoneInstall
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '../primitives/Button';
import { TextButton } from '../primitives/TextButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { Spinner } from '../primitives/Spinner';
import { OnboardingTerminal } from '../terminal/lazyTerminals';
import { ArrowLeftIcon, ChevronRightIcon, ExternalLinkIcon } from '@/components/icons';
import { useAsyncState } from '../../hooks/useAsyncState';
import { usePolling } from '../../hooks/usePolling';
import { useOptionalToast } from '../../contexts/ToastContext';
import { ensureAgentWorkdir } from '../../lib/agentOnboarding';
import { asCommandError, formatCommandError } from '../../lib/errors';
import {
  agentBlocked,
  agentInstallSpawn,
  ANDROID_APK_URL,
  installAgent,
  installPrompt,
  installSteps,
  installTarget,
  launchIosApp,
  loadInstallState,
  readInstallRecord,
  reinstallCommand,
  saveInstallRecord,
  shellSpawn,
  TESTFLIGHT_URL,
  type InstallPlatform,
  type InstallState,
} from '../../lib/companionInstall';
import { diagnoseBuildLog, getBuildLog, type BuildDiagnosis } from '../../lib/companionBuildLog';
import { BuildEnded, InstallChecklist, InstallDone } from './PhoneInstallSteps';
import { TailscaleStoreLinks } from './PhoneTailscale';
import { phoneTailscaleText, type TailscaleState } from '../../lib/companion';
import { phoneViaRelay } from '../../lib/account';

const PLATFORMS = [
  { value: 'ios', label: 'iPhone', ariaLabel: 'iPhone' },
  { value: 'android', label: 'Android', ariaLabel: 'Android' },
] as const;

const NAME: Record<InstallPlatform, string> = { ios: 'iPhone', android: 'Android phone' };

interface PhoneInstallProps {
  /** Reinstall from the Phone panel skips the route choice. */
  reinstall?: InstallPlatform;
  /** This Mac's Tailscale, for who the phone signs in as; null before it's read. */
  tailscale: TailscaleState | null;
  onBack: () => void;
  /** The app is on the phone: show the pairing code. */
  onPair: () => void;
}

export function PhoneInstall({ reinstall, tailscale, onBack, onPair }: PhoneInstallProps) {
  const [platform, setPlatform] = useState<InstallPlatform>(reinstall ?? 'ios');
  const [building, setBuilding] = useState(reinstall !== undefined);

  if (!building) {
    return (
      <RouteChoice
        platform={platform}
        tailscale={tailscale}
        onPlatform={setPlatform}
        onBuild={() => setBuilding(true)}
        onBack={onBack}
      />
    );
  }
  return (
    <BuildOnMac
      platform={platform}
      tailscale={tailscale}
      reinstall={reinstall !== undefined}
      onBack={reinstall ? onBack : () => setBuilding(false)}
      onPair={onPair}
    />
  );
}

// ---- Route choice --------------------------------------------------------------

interface ChoiceProps {
  platform: InstallPlatform;
  tailscale: TailscaleState | null;
  onPlatform: (p: InstallPlatform) => void;
  onBuild: () => void;
  onBack: () => void;
}

function RouteChoice({ platform, tailscale, onPlatform, onBuild, onBack }: ChoiceProps) {
  const official = platform === 'ios' ? TESTFLIGHT_URL : ANDROID_APK_URL;
  // Building it yourself is the advanced route while there is an official
  // build to get: folded away under it. With no official build it is the only
  // way, so it leads, unfolded and not called advanced, and the official card
  // that isn't there yet goes last (it led, a dead end, with the real route
  // below it labelled "advanced").
  const [advanced, setAdvanced] = useState(false);
  const officialRoute = (
    <div className="phone-route" data-unavailable={official ? undefined : ''}>
      <div className="phone-route__body">
        <span className="phone-route__title">
          {platform === 'ios' ? 'TestFlight' : 'Download the app'}
        </span>
        <span className="phone-route__detail">
          {platform === 'ios'
            ? 'The official build, through Apple’s TestFlight app. Two taps, nothing to build, and updates arrive on their own.'
            : 'The official APK: scan, download, and allow installing from your browser. Updates arrive on their own.'}
        </span>
      </div>
      {official ? (
        <Button
          variant="secondary"
          rightIcon={<ExternalLinkIcon size={12} />}
          onClick={() => void openUrl(official)}
        >
          {platform === 'ios' ? 'Open TestFlight' : 'Get the APK'}
        </Button>
      ) : (
        <span className="phone-route__badge">Not available yet</span>
      )}
    </div>
  );
  const buildRoute = (
    <div className="phone-route">
      <div className="phone-route__body">
        <span className="phone-route__title">Build it on this Mac</span>
        <span className="phone-route__detail">
          Your agent builds the app and installs it over a cable, and this app checks each step.
        </span>
        <span className="phone-route__detail">
          {platform === 'ios'
            ? 'Needs Xcode and an Apple ID. With a free Apple ID the app stops opening after 7 days; Reinstall here fixes that in one click.'
            : 'Needs USB debugging turned on on the phone. It doesn’t expire.'}
        </span>
      </div>
      <Button variant="primary" data-install-route="build" onClick={onBuild}>
        Set up
      </Button>
    </div>
  );
  return (
    <div className="settings-modal-body phone-install">
      <div className="phone-install__bar">
        <TextButton leftIcon={<ArrowLeftIcon size={12} />} onClick={onBack}>
          Phone
        </TextButton>
        <SegmentedControl
          aria-label="Your phone"
          value={platform}
          options={PLATFORMS}
          onValueChange={onPlatform}
        />
      </div>

      {official ? (
        <>
          {officialRoute}
          <PhoneTailscaleRoute platform={platform} tailscale={tailscale} />
          <TextButton
            className="phone-route__advanced"
            aria-expanded={advanced}
            rightIcon={<ChevronRightIcon size={10} className="phone-route__chevron" />}
            onClick={() => setAdvanced((v) => !v)}
          >
            Install it yourself (advanced)
          </TextButton>
          {advanced && buildRoute}
        </>
      ) : (
        <>
          {buildRoute}
          <PhoneTailscaleRoute platform={platform} tailscale={tailscale} />
          {officialRoute}
        </>
      )}
    </div>
  );
}

/**
 * Part of setting the phone up, whichever route the app came by, when the
 * phone reaches this Mac over Tailscale: without it on the phone, it never
 * reaches this Mac to pair. Not shown when it comes through the relay.
 */
function PhoneTailscaleRoute({
  platform,
  tailscale,
}: {
  platform: InstallPlatform;
  tailscale: TailscaleState | null;
}) {
  if (phoneViaRelay()) return null;
  return (
    <div className="phone-route" data-tailscale>
      <div className="phone-route__body">
        <span className="phone-route__title">And Tailscale on the {NAME[platform]}</span>
        <span className="phone-route__detail">
          {phoneTailscaleText(tailscale)} It’s how the phone reaches this Mac, so pairing waits for
          it.
        </span>
        <TailscaleStoreLinks platform={platform} />
      </div>
    </div>
  );
}

// ---- Build on this Mac ---------------------------------------------------------

/** `afterFailedBuild`: the agent was handed a Reinstall that failed, and starts from its log. */
type Run = { kind: 'agent' | 'reinstall'; key: number; afterFailedBuild?: boolean } | null;

interface BuildProps {
  platform: InstallPlatform;
  tailscale: TailscaleState | null;
  reinstall: boolean;
  onBack: () => void;
  onPair: () => void;
}

function BuildOnMac({ platform, tailscale, reinstall, onBack, onPair }: BuildProps) {
  const { showToast } = useOptionalToast();
  const load = useCallback(() => loadInstallState(platform), [platform]);
  const state = useAsyncState<InstallState>(load, { immediate: true });
  const s = state.data?.platform === platform ? state.data : null;
  const [run, setRun] = useState<Run>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [workdir, setWorkdir] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // Read from the build's log once a Reinstall fails: the one fix, when it's one we know.
  const [diagnosis, setDiagnosis] = useState<BuildDiagnosis | null>(null);
  const agent = useMemo(() => installAgent(), []);
  const now = Date.now();

  usePolling(state.execute, { intervalMs: 4000, name: 'phone-install-checks' });

  const steps = useMemo(() => (s ? installSteps(s) : []), [s]);
  const installed = s?.app?.installed === true;
  // Already on the phone counts as done, except for a reinstall: that
  // replaces an app that's there, so its build has to have finished too.
  const done = installed && (run === null ? !reinstall : run.kind === 'agent' || exitCode === 0);
  const target = s ? installTarget(s) : null;
  const command = s ? reinstallCommand(s) : null;
  const blocked = s ? agentBlocked(s) : false;
  const record = readInstallRecord();
  const canReinstall = record?.platform === platform && command !== null;

  // Remember the install, so the panel can say when it stops and remind.
  const expiresAt = s?.app?.expiresAt ?? null;
  useEffect(() => {
    if (!done || !target) return;
    const prev = readInstallRecord();
    const sameBuild = prev?.deviceId === target.id && prev.expiresAt === (expiresAt ?? undefined);
    if (sameBuild) return;
    saveInstallRecord({
      platform,
      deviceName: target.name,
      deviceId: target.id,
      teamId: s?.platform === 'ios' ? s.status.signing?.teamId : undefined,
      installedAt: Date.now(),
      expiresAt: expiresAt ?? undefined,
    });
  }, [done, target, expiresAt, platform, s]);

  const start = async (kind: 'agent' | 'reinstall', afterFailedBuild = false) => {
    let dir = s?.status.source.present ? s.status.source.path : null;
    dir ??= await ensureAgentWorkdir().catch(() => null);
    setWorkdir(dir);
    setExitCode(null);
    setDiagnosis(null);
    setRun((r) => ({ kind, key: (r?.key ?? 0) + 1, afterFailedBuild }));
  };

  const ended = (code: number, outputTail: string) => {
    setExitCode(code);
    if (run?.kind !== 'reinstall' || code === 0) return;
    // The log has the whole build; the terminal's own tail stands in if it can't be read.
    void getBuildLog()
      .catch(() => null)
      .then((log) => setDiagnosis(diagnoseBuildLog(log) ?? diagnoseBuildLog(outputTail)));
  };

  // Reinstall from the panel: the build starts once there's a phone to build for.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (reinstall && !autoStarted.current && command) {
      autoStarted.current = true;
      void start('reinstall');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reinstall, command]);

  const spawn = useMemo(() => {
    if (!run || !s) return null;
    if (run.kind === 'reinstall') return command ? shellSpawn(command) : null;
    return agentInstallSpawn(agent, installPrompt(s, run.afterFailedBuild));
    // The command is fixed per run: a poll mustn't respawn the terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const open = async () => {
    if (s?.platform !== 'ios' || !target || !s.status.signing) return;
    setOpening(true);
    try {
      await launchIosApp(target.id, s.status.signing.teamId);
    } catch (err) {
      showToast(formatCommandError(asCommandError(err)), 'error');
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="settings-modal-body phone-install phone-install--build">
      <div className="phone-install__bar">
        <TextButton leftIcon={<ArrowLeftIcon size={12} />} onClick={onBack}>
          {reinstall ? 'Phone' : 'Other ways'}
        </TextButton>
        <span className="phone-install__where">
          {reinstall ? 'Reinstall' : 'Build it on this Mac'} · {NAME[platform]}
        </span>
      </div>

      {!s ? (
        <div className="phone-loading">
          {state.error ? (
            <p className="phone-error">{formatCommandError(asCommandError(state.error))}</p>
          ) : (
            <Spinner />
          )}
        </div>
      ) : (
        <div className="phone-install__grid">
          <InstallChecklist steps={steps} agentName={agent.name} />

          <div className="phone-install__work">
            {done && target ? (
              <InstallDone
                platform={platform}
                deviceName={target.name}
                tailscaleLine={phoneViaRelay() ? null : phoneTailscaleText(tailscale)}
                expiresAt={expiresAt}
                now={now}
                opening={opening}
                onOpen={platform === 'ios' ? () => void open() : undefined}
                onPair={onPair}
              />
            ) : run && spawn && workdir ? (
              <div className="phone-install__terminal">
                <OnboardingTerminal
                  key={run.key}
                  command={spawn.command}
                  args={spawn.args}
                  cwd={workdir}
                  onExit={(code, tail) => ended(code ?? 0, tail)}
                />
                {exitCode !== null && !done && (
                  <BuildEnded
                    kind={run.kind}
                    exitCode={exitCode}
                    agentName={agent.name}
                    diagnosis={diagnosis}
                    canRetry={command !== null}
                    onRetry={() => void start('reinstall')}
                    onAgent={() => void start('agent', run.kind === 'reinstall' && exitCode !== 0)}
                  />
                )}
              </div>
            ) : (
              <div className="phone-install-start">
                <h3 className="phone-install-start__title">
                  {reinstall && !command
                    ? `Plug in ${record?.deviceName ?? 'your phone'} to reinstall`
                    : `${agent.name} does the work`}
                </h3>
                <p className="phone-install-start__text">
                  It checks what’s missing, installs it, and builds the app, stopping to tell you
                  when something needs your hands: a tap on the phone, or your Mac password. The
                  checklist turns green only when this app’s own checks pass.
                </p>
                <p className="phone-install-start__note">
                  {platform !== 'ios'
                    ? 'Android builds don’t expire. Reinstall only when you want a newer version.'
                    : s.platform === 'ios' && s.status.signing?.free === false
                      ? 'Your Apple developer account’s builds keep working for a year. Reinstall here whenever you want a newer version.'
                      : 'With a free Apple ID, the app stops opening after 7 days. Reinstalling takes one click here and no agent, and you’re reminded the day before. A paid developer account lasts a year.'}
                </p>
                <div className="phone-install-start__actions">
                  <Button
                    variant="primary"
                    disabled={blocked}
                    data-install-start
                    onClick={() => void start('agent')}
                  >
                    Start {agent.name}
                  </Button>
                  {canReinstall && (
                    <Button variant="secondary" onClick={() => void start('reinstall')}>
                      Reinstall without the agent
                    </Button>
                  )}
                </div>
                {blocked && (
                  <p className="phone-install-start__blocked">
                    Update Xcode first. The agent can’t install App Store updates, and the build
                    needs Xcode {s.platform === 'ios' ? s.status.xcodeMinimum : ''} or later.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
