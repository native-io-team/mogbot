/**
 * Welcome and pairing, one screen at a time (`lib/pairSteps`): one question,
 * one big button, Back and a progress bar on every screen.
 *
 * Do you have the app on your Mac? (Not yet: where to get it) → Tailscale on
 * this phone, signed in as the Mac is (ticks Done when this phone can see
 * it) → "On your Mac, click Pair your phone" (Scan the code) → the camera
 * → "Pair with <Mac>?" → "Reaching <Mac>…" while it proves itself → "Click
 * Allow on your Mac" (said only once the code has really gone; ticks by
 * itself) → "Paired with <Mac>", and alerts once if they're undecided.
 *
 * Every word that names a button on the Mac is the Mac's own
 * (`companion-protocol/src/pairWords.ts`). Deep links (`…://pair?d=…`)
 * land on the confirm too, and never pair without it: any web page or
 * message can open one. "Try the demo" stays as a quiet link on the first
 * screen only.
 */

import {
  ALLOW_BUTTON,
  CHIEF_COLORWAY,
  CHIEF_ICON,
  CLICK_ALLOW_TITLE,
  CLICK_PAIR_TITLE,
  GET_MAC_LINE,
  GET_MAC_TITLE,
  HAVE_MAC_TITLE,
  I_DID_IT,
  PAIR_BUTTON,
  PAIRED_TITLE,
  PAIRING_SCHEME,
  SAME_ACCOUNT_LINE,
  SCAN_THE_CODE,
  TAILSCALE_LINE,
  TAILSCALE_PHONE_TITLE,
  type PairingLink,
} from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import * as Notifications from 'expo-notifications';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Share, View } from 'react-native';
import Animated, { FadeInDown, ZoomIn } from 'react-native-reanimated';
import { Spinner } from '../components/agent';
import { AgentKey } from '../components/AgentKey';
import { DoneLine, StepScreen } from '../components/StepScreen';
import { Button, Icon, T } from '../components/ui';
import { ALERTS_WHILE_OPEN } from '../lib/push';
import {
  cleanName,
  linkHost,
  openTailscale,
  pair,
  PairError,
  linkProblem,
  pairPlan,
  parseLink,
  MAC_DOWNLOAD_URL,
  PHONE_SETTINGS,
  WHERE_TO_PAIR,
  type PairFailure,
  type PairPlan,
} from '../lib/pairing';
import {
  nextIntro,
  PAIR_STAGES,
  prevIntro,
  progressOf,
  readSavedStep,
  saveStep,
  stageOf,
  startStep,
  type IntroStep,
} from '../lib/pairSteps';
import { reachChecklist, reachDetail } from '../lib/reachChecklist';
import { ReachChecklist, useTailscaleInstalled } from '../components/ReachChecklist';
import { adopt, enableAlerts } from '../lib/session';
import { isDemo } from '../lib/demo';
import { PAIRING_LOST } from '../lib/identity';
import { useApp } from '../lib/store';
import { haptic } from '../lib/haptics';
import { iconSize, keySize, radius, space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

type Phase =
  | { kind: 'start'; error?: string }
  /** Say which Mac, where, and what it replaces; nothing is sent until Pair. */
  | { kind: 'confirm'; link: PairingLink; plan: PairPlan }
  /** Asking the Mac to prove itself: nothing has reached the desk yet. */
  | { kind: 'reaching'; link: PairingLink }
  /** The Mac proved itself and has the code: the desk is asking now. */
  | { kind: 'waiting'; link: PairingLink }
  | { kind: 'failed'; link: PairingLink; failure: PairFailure }
  | { kind: 'paired'; mac: string; askAlerts: boolean };

/** How long the success moment stays when there's nothing to decide on it. */
const PAIRED_MS = 2400;

export default function Pair() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const params = useLocalSearchParams<{ d?: string; link?: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'start' });
  const abort = useRef<AbortController | null>(null);
  const current = useApp((s) => s.credentials);
  const pairingLost = useApp((s) => s.pairingLost);
  // Paired before (another Mac, or this one before a reset): the first three
  // steps are done already, so it opens on the Mac's button.
  const pairedBefore = (!!current && !isDemo(current)) || pairingLost;
  const [intro, setIntro] = useState<IntroStep | null>(null);
  useEffect(() => {
    let live = true;
    void readSavedStep().then((saved) => live && setIntro(startStep(saved, pairedBefore)));
    return () => {
      live = false;
    };
    // Once, on arrival: a later change of pairing doesn't move the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const goIntro = useCallback((step: IntroStep | null) => {
    if (!step) return;
    saveStep(step);
    setIntro(step);
  }, []);

  const begin = useCallback(async (link: PairingLink) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: 'reaching', link });
    try {
      const credentials = await pair(link, controller.signal, (step) => {
        if (!controller.signal.aborted)
          setPhase({ kind: step === 'asking' ? 'waiting' : 'reaching', link });
      });
      await adopt(credentials);
      haptic.success();
      // Say which Mac, always; ask about alerts only when there's a decision to make.
      const { status } = await Notifications.getPermissionsAsync().catch(() => ({
        status: Notifications.PermissionStatus.DENIED,
      }));
      // Left the screen meanwhile: paired all the same, nothing to show.
      if (controller.signal.aborted) return;
      setPhase({
        kind: 'paired',
        mac: credentials.name,
        askAlerts: status === Notifications.PermissionStatus.UNDETERMINED,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      haptic.error();
      setPhase({
        kind: 'failed',
        link,
        failure:
          error instanceof PairError
            ? error.failure
            : { kind: 'other', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }, []);

  /** Every link stops here first: the scanner's, a paste, or one another app opened. */
  const review = useCallback(
    (link: PairingLink) => {
      abort.current?.abort();
      // The demo is no Mac: pairing one simply ends it.
      const real = current && !isDemo(current) ? current : null;
      setPhase({ kind: 'confirm', link, plan: pairPlan(link, real) });
    },
    [current]
  );

  // Arrived with a link (deep link, or the scanner).
  const incoming = params.link ?? (params.d ? `${PAIRING_SCHEME}://pair?d=${params.d}` : null);
  const incomingLink = incoming ? parseLink(incoming) : null;
  useEffect(() => {
    if (incomingLink) review(incomingLink);
    // Keyed on the text: a parsed link is a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming]);

  useEffect(() => () => abort.current?.abort(), []);

  const paste = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    const link = parseLink(text);
    if (link) review(link);
    else {
      goIntro('code');
      setPhase({ kind: 'start', error: linkProblem(text) });
    }
  };

  const finish = useCallback(() => router.replace('/agents'), [router]);

  // Nothing to decide: the success moment shows, then gives way to your agents.
  const autoFinish = phase.kind === 'paired' && !phase.askAlerts;
  useEffect(() => {
    if (!autoFinish) return;
    const timer = setTimeout(finish, PAIRED_MS);
    return () => clearTimeout(timer);
  }, [autoFinish, finish]);

  /** Back to the Mac's button: where every way out of a pairing lands. */
  const toCode = () => {
    abort.current?.abort();
    if (incoming) router.setParams({ link: undefined, d: undefined });
    goIntro('code');
    setPhase({ kind: 'start' });
  };

  if (phase.kind === 'start') {
    if (!intro) return <View style={{ flex: 1, backgroundColor: colors.surfaceApp }} />;
    const error = phase.error ?? (incoming && !incomingLink ? linkProblem(incoming) : null);
    return (
      <IntroScreen
        step={intro}
        go={goIntro}
        notice={
          <>
            {pairingLost && (
              <View testID="pairing-lost" style={styles.notice}>
                <T variant="headline" color={colors.textStrong}>
                  Pair again
                </T>
                <T color={colors.textSecondary}>{PAIRING_LOST}</T>
              </View>
            )}
            {error && intro === 'code' && (
              <Animated.View entering={FadeInDown.duration(200)}>
                <T variant="small" color={colors.accentErrorLight}>
                  {error}
                </T>
              </Animated.View>
            )}
          </>
        }
        onScan={() => router.push('/scan')}
        onPaste={() => void paste()}
      />
    );
  }

  if (phase.kind === 'confirm') {
    return (
      <Confirm
        link={phase.link}
        plan={phase.plan}
        onPair={() => void begin(phase.link)}
        onCancel={toCode}
      />
    );
  }

  if (phase.kind === 'reaching') {
    return (
      <StepScreen
        stepKey="reaching"
        {...progressOf('pair')}
        testID="pair-reaching"
        busy={<Spinner size={iconSize.body} color={colors.textPrimary} />}
        title={`Reaching ${cleanName(phase.link.name)}…`}
        line="Finding it over Tailscale and checking it’s the Mac this code came from. Nothing is sent to it until it proves that."
        secondary={<Button title="Cancel" variant="ghost" onPress={toCode} />}
      />
    );
  }

  if (phase.kind === 'waiting') {
    return (
      <StepScreen
        stepKey="waiting"
        {...progressOf('allow')}
        testID="pair-waiting"
        busy={<Spinner size={iconSize.body} color={colors.textPrimary} />}
        title={CLICK_ALLOW_TITLE}
        line={`${cleanName(phase.link.name)} is asking whether to let this phone use your agents. Check the code there ends in ${codeEnd(phase.link)}, then click ${ALLOW_BUTTON}. This waits up to two minutes.`}
        secondary={<Button title="Cancel" variant="ghost" onPress={toCode} />}
      />
    );
  }

  if (phase.kind === 'failed') {
    const kind = phase.failure.kind;
    const unreachable = kind === 'tailscale_off' || kind === 'mac_unreachable';
    const newCode =
      kind === 'expired' || kind === 'refused' || kind === 'no_answer' || kind === 'not_your_mac';
    const [title, body] = failureCopy(phase.failure, cleanName(phase.link.name));
    return (
      <StepScreen
        stepKey="failed"
        {...progressOf('pair')}
        testID="pair-failed"
        onBack={toCode}
        title={title}
        line={body}
        primary={
          newCode ? (
            <Button
              title="Scan a new code"
              variant="primary"
              size="large"
              onPress={() => router.push('/scan')}
            />
          ) : (
            <Button
              title="Try again"
              variant="primary"
              size="large"
              onPress={() => void begin(phase.link)}
            />
          )
        }
        secondary={<Button title="Back" variant="ghost" onPress={toCode} />}
      >
        {unreachable && (
          <Unreachable
            mac={cleanName(phase.link.name)}
            host={linkHost(phase.link)}
            diagnosis={kind}
          />
        )}
      </StepScreen>
    );
  }

  // Paired: the bar full, which Mac, then your agents.
  return (
    <StepScreen
      stepKey="paired"
      n={PAIR_STAGES.length + 1}
      of={PAIR_STAGES.length}
      testID="pair-paired"
      centered
      mark={
        <Animated.View entering={ZoomIn.duration(420).springify()} style={styles.check}>
          <Icon
            name="checkmark"
            size={iconSize.hero}
            color={colors.accentSuccess}
            fallback={<T>✓</T>}
          />
        </Animated.View>
      }
      title={`${PAIRED_TITLE} with ${phase.mac}`}
      line={
        phase.askAlerts
          ? `Want a tap on the shoulder when an agent needs you or finishes? ${ALERTS_WHILE_OPEN}`
          : 'Opening your agents…'
      }
      primary={
        phase.askAlerts ? (
          <Button
            title="Turn on alerts"
            variant="primary"
            size="large"
            onPress={async () => {
              await enableAlerts();
              finish();
            }}
          />
        ) : undefined
      }
      secondary={
        phase.askAlerts ? <Button title="Not now" variant="ghost" onPress={finish} /> : undefined
      }
    >
      {phase.askAlerts && (
        <T variant="small" color={colors.textMuted}>
          With the official app, your Mac can also wake this phone through the push service. It
          sends only that an agent needs you or finished, never what it said.
        </T>
      )}
    </StepScreen>
  );
}

/**
 * The three screens before the camera, one question each. Each says only
 * what to do next and has one big button for it. Only what this phone can
 * see gets a tick (Tailscale installed here); the rest is the person's word,
 * and the button says so ("I did it", "It’s on").
 */
function IntroScreen({
  step,
  go,
  notice,
  onScan,
  onPaste,
}: {
  step: IntroStep;
  go: (step: IntroStep | null) => void;
  notice: ReactNode;
  onScan: () => void;
  onPaste: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const installed = useTailscaleInstalled();
  const back = prevIntro(step);
  const common = {
    stepKey: step,
    ...progressOf(stageOf(step)),
    onBack: back ? () => go(back) : undefined,
    notice,
    testID: `pair-${step}`,
  };
  const next = () => go(nextIntro(step));

  switch (step) {
    case 'mac':
      return (
        <StepScreen
          {...common}
          mark={
            <View style={styles.logo}>
              <AgentKey
                name="Chief of Staff"
                colorway={CHIEF_COLORWAY}
                icon={CHIEF_ICON}
                boundKey="C"
                size={keySize.lg}
              />
            </View>
          }
          title={HAVE_MAC_TITLE}
          line="Your agents run there. This phone is how you reach them when you’re away from it."
          primary={<Button title="Yes" variant="primary" size="large" onPress={next} />}
          secondary={
            <Button title="Not yet" variant="ghost" onPress={() => go('getMac')} />
          }
          footer={<TryDemo />}
        />
      );
    case 'getMac':
      return (
        <StepScreen
          {...common}
          title={GET_MAC_TITLE}
          line={GET_MAC_LINE}
          primary={
            MAC_DOWNLOAD_URL ? (
              <Button
                title="Send the link to my Mac"
                variant="primary"
                size="large"
                icon="square.and.arrow.up"
                onPress={() =>
                  void Share.share({ message: MAC_DOWNLOAD_URL!, url: MAC_DOWNLOAD_URL! }).catch(
                    () => {}
                  )
                }
              />
            ) : (
              <Button title="I have it now" variant="primary" size="large" onPress={next} />
            )
          }
          secondary={
            MAC_DOWNLOAD_URL ? (
              <Button title="I have it now" variant="ghost" onPress={next} />
            ) : undefined
          }
        >
          {MAC_DOWNLOAD_URL && (
            <View style={styles.address} testID="mac-download">
              <T variant="small" color={colors.textMuted}>
                On your Mac, go to
              </T>
              <T color={colors.textStrong} selectable>
                {MAC_DOWNLOAD_URL.replace(/^https?:\/\//, '')}
              </T>
            </View>
          )}
        </StepScreen>
      );
    case 'tailscale':
      return (
        <StepScreen
          {...common}
          title={TAILSCALE_PHONE_TITLE}
          line={
            installed
              ? `${TAILSCALE_LINE} Open it and switch it on. ${SAME_ACCOUNT_LINE}`
              : `${TAILSCALE_LINE} Install it and switch it on; it asks to add a VPN configuration: tap Allow. ${SAME_ACCOUNT_LINE}`
          }
          primary={
            installed ? (
              <Button title="It’s on" variant="primary" size="large" onPress={next} />
            ) : (
              <Button
                title={installed === false ? 'Get Tailscale' : 'Open Tailscale'}
                variant="primary"
                size="large"
                icon="network"
                onPress={() => void openTailscale()}
              />
            )
          }
          secondary={
            installed ? (
              <Button
                title="Open Tailscale"
                variant="ghost"
                icon="network"
                onPress={() => void openTailscale()}
              />
            ) : (
              <Button title={I_DID_IT} variant="ghost" onPress={next} />
            )
          }
        >
          {installed && <DoneLine>Tailscale is installed on this phone.</DoneLine>}
        </StepScreen>
      );
    case 'code':
      return (
        <StepScreen
          {...common}
          title={CLICK_PAIR_TITLE}
          line="Already looking at a code on your Mac? Scan it now. The first time, this phone asks to use the camera."
          primary={
            <Button
              title={SCAN_THE_CODE}
              variant="primary"
              size="large"
              icon="qrcode.viewfinder"
              onPress={onScan}
            />
          }
          secondary={
            <Button
              title="Paste a pairing link instead"
              variant="ghost"
              icon="doc.on.clipboard"
              onPress={onPaste}
            />
          }
        />
      );
  }
}

const codeEnd = (link: PairingLink) => link.code.slice(-4);

/**
 * "Pair with Julian's MacBook Pro?" at its address, and the code's end.
 * Nothing has been sent yet. A link that claims the paired Mac with a
 * different key stops here for good.
 */
function Confirm({
  link,
  plan,
  onPair,
  onCancel,
}: {
  link: PairingLink;
  plan: PairPlan;
  onPair: () => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const name = cleanName(link.name);
  if (plan.kind === 'impostor') {
    return (
      <StepScreen
        stepKey="impostor"
        {...progressOf('pair')}
        onBack={onCancel}
        title="This isn’t your Mac"
        line={`This link says it’s ${cleanName(plan.current)}, but it carries a different identity than the Mac this phone is paired with. Nothing was sent. If you set that Mac up again, forget it in Settings first, then pair from it.`}
        primary={<Button title="Back" variant="primary" size="large" onPress={onCancel} />}
      />
    );
  }
  return (
    <StepScreen
      stepKey="confirm"
      {...progressOf('pair')}
      onBack={onCancel}
      testID="pair-confirm"
      title={`Pair with ${name}?`}
      line={
        <>
          The code ends in{' '}
          <T color={colors.textStrong} style={styles.mono}>
            {codeEnd(link)}
          </T>
          . Only go on if you just made this code on your own Mac.
        </>
      }
      primary={<Button title={PAIR_BUTTON} variant="primary" size="large" onPress={onPair} />}
      secondary={<Button title="Cancel" variant="ghost" onPress={onCancel} />}
    >
      <T variant="small" color={colors.textMuted}>
        at {linkHost(link)}
      </T>
      {plan.kind === 'replace' && (
        <T variant="small" color={colors.accentErrorLight}>
          This replaces {cleanName(plan.current)}: this phone stops showing its agents.
        </T>
      )}
      {plan.kind === 'again' && (
        <T variant="small" color={colors.textMuted}>
          This phone is already paired with {name}. Pairing again replaces that pairing.
        </T>
      )}
    </StepScreen>
  );
}

/**
 * No Mac to pair yet: a look around with sample agents (lib/demo.ts), said
 * plainly to be samples. Quiet, on the first screen only; not while a real
 * Mac is paired.
 */
function TryDemo() {
  const colors = useColors();
  const router = useRouter();
  const paired = useApp((s) => !!s.credentials && !isDemo(s.credentials));
  if (paired) return null;
  return (
    <View style={{ gap: space.xs, marginTop: space.md }} testID="pair-demo">
      <Button title="Try the demo" variant="ghost" onPress={() => router.replace('/demo')} />
      <T variant="small" color={colors.textMuted} style={{ textAlign: 'center' }}>
        No Mac nearby? Look around with sample agents. Nothing is sent anywhere.
      </T>
    </View>
  );
}

/**
 * Nothing answered: the three things that have to be true, each with what
 * this phone can see of it and its fix. The address is folded away.
 */
function Unreachable({
  mac,
  host,
  diagnosis,
}: {
  mac: string;
  host: string;
  diagnosis: 'tailscale_off' | 'mac_unreachable';
}) {
  const phoneOnline = useApp((s) => s.phoneOnline);
  const installed = useTailscaleInstalled();
  return (
    <ReachChecklist
      checks={reachChecklist({
        mac,
        phoneOnline,
        tailscaleInstalled: installed,
        diagnosis,
        paired: { kind: 'not_yet' },
      })}
      detail={reachDetail(host)}
    />
  );
}

/** A failure's title and its one line. */
function failureCopy(failure: PairFailure, mac: string): [string, string] {
  switch (failure.kind) {
    // A checklist follows (`Unreachable`): no address in the first line.
    case 'tailscale_off':
    case 'mac_unreachable':
      return [`Can’t reach ${mac}`, 'Check these, then try again.'];
    case 'no_answer':
      return [
        `No answer from ${mac}`,
        `The Mac had the request, but nothing came back within two minutes. If you clicked Allow, open ${PHONE_SETTINGS} on the Mac to check this phone is listed; otherwise click ${WHERE_TO_PAIR} for a new code and scan it.`,
      ];
    case 'not_your_mac':
      return [
        'This isn’t your Mac',
        `The server at this address couldn’t prove it’s ${mac}, so this phone didn’t send it your code or anything else. On your Mac, click ${WHERE_TO_PAIR} for a new code and scan that.`,
      ];
    case 'lan_only':
      return [
        'This code only offers your local network',
        `This version of the app connects over Tailscale. Turn on Tailscale on your Mac, then click ${WHERE_TO_PAIR} for a new code.`,
      ];
    case 'expired':
      return [
        'This code has expired',
        `A code works once and for five minutes. On your Mac, click ${WHERE_TO_PAIR} for a new one, then scan it.`,
      ];
    case 'refused':
      return [
        failure.reason === 'denied'
          ? `${mac} said no`
          : failure.reason === 'timeout'
            ? 'Nobody answered on the Mac'
            : failure.reason === 'update_mac'
              ? `Update the app on ${mac} to pair`
              : failure.reason === 'update_app'
                ? 'Update this app to pair'
                : failure.reason === 'unavailable'
                  ? `${mac} can’t prove who it is right now`
                  : 'This code can’t be used',
        failure.message,
      ];
    case 'other':
      return ['Pairing didn’t work', failure.message];
  }
}

const useStyles = makeStyles((colors) => ({
  logo: { alignSelf: 'flex-start', marginBottom: space.sm },
  notice: { gap: space.xs },
  address: {
    gap: space.xs,
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
  },
  mono: { fontVariant: ['tabular-nums'], letterSpacing: 1 },
  // The paired moment's mark: large, ringed in the success colour, springing in.
  check: {
    width: keySize.xl,
    height: keySize.xl,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfacePanel,
    borderWidth: space['2xs'],
    borderColor: colors.accentSuccess,
    marginBottom: space.lg,
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
