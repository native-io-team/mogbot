/**
 * Welcome and pairing: one screen with the four numbered steps (the Mac app,
 * Tailscale on both, the desk's "Pair your phone", scan) said in the desk's
 * own words (`companion-protocol/src/pairWords.ts`), one big "Scan the code"
 * and "Try the demo" under it; then a confirm
 * screen that says which Mac and where, "Reaching <Mac>…" while it proves
 * itself, wait for someone at the desk to allow it (said only once the code
 * has really gone), then a moment that says which Mac it's paired
 * with, and asks about alerts once if they're undecided. Deep links
 * (`…://pair?d=…`) land here too, and never pair without the confirm: any
 * web page or message can open one.
 */

import {
  APP_NAME,
  CHIEF_COLORWAY,
  CHIEF_ICON,
  PAIR_BUTTON,
  PAIR_WHERE,
  PAIR_YOUR_PHONE,
  SCAN_THE_CODE,
  type PairingLink,
} from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import * as Notifications from 'expo-notifications';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { AgentKey } from '../components/AgentKey';
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
  tailscaleInstalled,
  MAC_DOWNLOAD_URL,
  PHONE_SETTINGS,
  WHERE_TO_PAIR,
  type PairFailure,
  type PairPlan,
} from '../lib/pairing';
import { reachChecklist, reachDetail } from '../lib/reachChecklist';
import { ReachChecklist, useTailscaleInstalled } from '../components/ReachChecklist';
import { adopt, enableAlerts } from '../lib/session';
import { isDemo } from '../lib/demo';
import { PAIRING_LOST } from '../lib/identity';
import { useApp } from '../lib/store';
import { PAIRING_SCHEME } from '@shipstudio/companion-protocol';
import { haptic } from '../lib/haptics';
import { iconSize, keySize, radius, space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
// The placeholder tile (unbranded) until real branding lands.

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
const PAIRED_MS = 1600;

export default function Pair() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ d?: string; link?: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'start' });
  const abort = useRef<AbortController | null>(null);
  const current = useApp((s) => s.credentials);
  const pairingLost = useApp((s) => s.pairingLost);

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
    else setPhase({ kind: 'start', error: linkProblem(text) });
  };

  const finish = useCallback(() => router.replace('/agents'), [router]);

  // Nothing to decide: the success moment shows, then gives way to your agents.
  const autoFinish = phase.kind === 'paired' && !phase.askAlerts;
  useEffect(() => {
    if (!autoFinish) return;
    const timer = setTimeout(finish, PAIRED_MS);
    return () => clearTimeout(timer);
  }, [autoFinish, finish]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surfaceApp }}
      contentContainerStyle={[
        styles.page,
        { paddingTop: insets.top + space['2xl'], paddingBottom: insets.bottom + space.xl },
      ]}
      bounces={false}
    >
      <View style={styles.hero}>
        {/* The app's mark: the Chief's key, as the desk's onboarding shows it. In
            full on the first screen; past it, the key alone, so a failure's
            checklist and its buttons stay on screen. */}
        <View style={styles.logo}>
          <AgentKey
            name="Chief of Staff"
            colorway={CHIEF_COLORWAY}
            icon={CHIEF_ICON}
            boundKey="C"
            size={keySize.lg}
          />
        </View>
        {phase.kind === 'start' && (
          <>
            <T variant="display" color={colors.textStrong} accessibilityRole="header">
              Pair with your Mac
            </T>
            <T color={colors.textSecondary}>
              Your agents run in {APP_NAME} on your Mac. Pair once, and talk to them from here.
            </T>
          </>
        )}
      </View>

      {phase.kind === 'start' && (
        <Animated.View entering={FadeIn.duration(200)} style={styles.block}>
          {pairingLost && (
            <View testID="pairing-lost">
              <T variant="headline" color={colors.textStrong}>
                Pair again
              </T>
              <T color={colors.textSecondary}>{PAIRING_LOST}</T>
            </View>
          )}
          {(phase.error ?? (incoming && !incomingLink ? linkProblem(incoming) : null)) && (
            <Animated.View entering={FadeInDown.duration(200)}>
              <T variant="small" color={colors.accentErrorLight}>
                {phase.error ?? (incoming ? linkProblem(incoming) : null)}
              </T>
            </Animated.View>
          )}
          <PairSteps />
          <Button
            title={SCAN_THE_CODE}
            variant="primary"
            size="large"
            icon="qrcode.viewfinder"
            onPress={() => router.push('/scan')}
          />
          <Button
            title="Paste a pairing link instead"
            variant="ghost"
            icon="doc.on.clipboard"
            onPress={() => void paste()}
          />
          <TryDemo />
        </Animated.View>
      )}

      {phase.kind === 'confirm' && (
        <Confirm
          link={phase.link}
          plan={phase.plan}
          onPair={() => void begin(phase.link)}
          onCancel={() => {
            if (incoming) router.setParams({ link: undefined, d: undefined });
            setPhase({ kind: 'start' });
          }}
        />
      )}

      {phase.kind === 'reaching' && (
        <Animated.View
          entering={FadeInDown.duration(250)}
          exiting={FadeOut.duration(150)}
          style={[styles.card, styles.block]}
          testID="pair-reaching"
        >
          <View style={styles.waitingTitle}>
            <Spinner size={iconSize.body} color={colors.textPrimary} />
            <T variant="title" color={colors.textStrong} accessibilityRole="header">
              Reaching {cleanName(phase.link.name)}…
            </T>
          </View>
          <T color={colors.textSecondary}>
            Looking for it at {linkHost(phase.link)} over Tailscale, and checking it’s the Mac this
            code came from. Nothing has been sent to it yet.
          </T>
          <Button
            title="Cancel"
            variant="ghost"
            onPress={() => {
              abort.current?.abort();
              setPhase({ kind: 'start' });
            }}
          />
        </Animated.View>
      )}

      {phase.kind === 'waiting' && (
        <Animated.View
          entering={FadeInDown.duration(250)}
          exiting={FadeOut.duration(150)}
          style={[styles.card, styles.block]}
        >
          <View style={styles.waitingTitle}>
            <Spinner size={iconSize.body} color={colors.textPrimary} />
            <T variant="title" color={colors.textStrong} accessibilityRole="header">
              Allow on your Mac
            </T>
          </View>
          <T color={colors.textSecondary}>
            {cleanName(phase.link.name)} is asking whether to let this phone use your agents. Check
            the code there ends in {codeEnd(phase.link)}, then click Allow. This waits up to two
            minutes.
          </T>
          <Button
            title="Cancel"
            variant="ghost"
            onPress={() => {
              abort.current?.abort();
              setPhase({ kind: 'start' });
            }}
          />
        </Animated.View>
      )}

      {phase.kind === 'failed' && (
        <Animated.View entering={FadeInDown.duration(250)} style={[styles.card, styles.block]}>
          <FailureCopy failure={phase.failure} mac={cleanName(phase.link.name)} />
          {(phase.failure.kind === 'tailscale_off' || phase.failure.kind === 'mac_unreachable') && (
            <Unreachable
              mac={cleanName(phase.link.name)}
              host={linkHost(phase.link)}
              diagnosis={phase.failure.kind}
            />
          )}
          {phase.failure.kind === 'expired' ||
          phase.failure.kind === 'refused' ||
          phase.failure.kind === 'no_answer' ||
          phase.failure.kind === 'not_your_mac' ? (
            <Button
              title="Scan a new code"
              variant="primary"
              onPress={() => router.push('/scan')}
            />
          ) : (
            <Button title="Try again" variant="primary" onPress={() => void begin(phase.link)} />
          )}
          <Button title="Back" variant="ghost" onPress={() => setPhase({ kind: 'start' })} />
        </Animated.View>
      )}

      {phase.kind === 'paired' && (
        <Animated.View entering={FadeInDown.duration(250)} style={[styles.card, styles.block]}>
          <Animated.View entering={ZoomIn.duration(260).springify()} style={styles.check}>
            <Icon
              name="checkmark"
              size={iconSize.button}
              color={colors.accentSuccess}
              fallback={<T>✓</T>}
            />
          </Animated.View>
          <T variant="title" color={colors.textStrong} accessibilityRole="header">
            Paired with {phase.mac}
          </T>
          {phase.askAlerts ? (
            <>
              <T color={colors.textSecondary}>
                Want a tap on the shoulder when an agent needs you or finishes? {ALERTS_WHILE_OPEN}
              </T>
              <T variant="small" color={colors.textMuted}>
                With the official app, your Mac can also wake this phone through the push service.
                It sends only that an agent needs you or finished, never what it said.
              </T>
              <Button
                title="Turn on alerts"
                variant="primary"
                onPress={async () => {
                  await enableAlerts();
                  finish();
                }}
              />
              <Button title="Not now" variant="ghost" onPress={finish} />
            </>
          ) : (
            <T color={colors.textSecondary}>Opening your agents…</T>
          )}
        </Animated.View>
      )}
    </ScrollView>
  );
}

const codeEnd = (link: PairingLink) => link.code.slice(-4);

/**
 * "Pair with Julian's MacBook Pro at julians-mbp.tail1234.ts.net?" Nothing
 * has been sent yet. A link that claims the paired Mac with a different key
 * stops here for good.
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
      <Animated.View entering={FadeInDown.duration(250)} style={[styles.card, styles.block]}>
        <T variant="title" color={colors.accentErrorLight} accessibilityRole="header">
          This isn’t your Mac
        </T>
        <T color={colors.textSecondary}>
          This link says it’s {cleanName(plan.current)}, but it carries a different identity than
          the Mac this phone is paired with. Nothing was sent. If you set that Mac up again, forget
          it in Settings first, then pair from it.
        </T>
        <Button title="Back" variant="primary" onPress={onCancel} />
      </Animated.View>
    );
  }
  return (
    <Animated.View
      entering={FadeInDown.duration(250)}
      style={[styles.card, styles.block]}
      testID="pair-confirm"
    >
      <T variant="title" color={colors.textStrong} accessibilityRole="header">
        Pair with {name}?
      </T>
      <T color={colors.textSecondary}>
        at <T color={colors.textPrimary}>{linkHost(link)}</T>
      </T>
      <T color={colors.textSecondary}>
        The code ends in{' '}
        <T color={colors.textPrimary} style={styles.mono}>
          {codeEnd(link)}
        </T>
        . Only go on if you just made this code on your own Mac.
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
      <Button title="Pair" variant="primary" onPress={onPair} />
      <Button title="Cancel" variant="ghost" onPress={onCancel} />
    </Animated.View>
  );
}

/**
 * The first screen, in one glance: four numbered steps, each in the words
 * the Mac really shows. Tailscale is a step of its own, before the scan,
 * because the phone reaches the Mac only through it (a `*.ts.net` address):
 * said after a spinner that never ends, it was the surprise nobody solved.
 * Each step that needs something from outside carries its one link.
 */
function PairSteps() {
  const colors = useColors();
  const styles = useStyles();
  // "Open" only when the OS says the app is there; otherwise "Get".
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void tailscaleInstalled().then((v) => live && setInstalled(v));
    return () => {
      live = false;
    };
  }, []);
  const steps: { title: string; detail?: string; action?: ReactNode }[] = [
    {
      title: `On your Mac, open ${APP_NAME}.`,
      detail: MAC_DOWNLOAD_URL ? `Don’t have it yet? Download it for your Mac first.` : undefined,
      action: MAC_DOWNLOAD_URL ? (
        <Button
          title={`Get ${APP_NAME} for Mac`}
          variant="outline"
          icon="square.and.arrow.down"
          onPress={() => void Linking.openURL(MAC_DOWNLOAD_URL!)}
        />
      ) : undefined,
    },
    {
      title: 'Turn on Tailscale on this phone and on your Mac.',
      detail:
        'A free app that links the two privately. Sign in to the same account on both, and switch it on.',
      action: (
        <Button
          title={installed === false ? 'Get Tailscale' : 'Open Tailscale'}
          variant="outline"
          icon="network"
          onPress={() => void openTailscale()}
        />
      ),
    },
    {
      title: `On your Mac, click “${PAIR_YOUR_PHONE}” ${PAIR_WHERE}.`,
      detail: 'A code appears on the Mac.',
    },
    {
      title: `Tap ${SCAN_THE_CODE} here and point the camera at it.`,
      detail: `Then tap ${PAIR_BUTTON}, and click Allow on your Mac.`,
    },
  ];
  return (
    <View style={[styles.card, styles.steps]} testID="pair-steps">
      {steps.map((step, i) => (
        <View key={step.title} style={styles.step}>
          <View style={styles.stepNumber}>
            <T variant="small" color={colors.textStrong} style={styles.stepDigit}>
              {i + 1}
            </T>
          </View>
          <View style={styles.stepBody}>
            <T variant="headline" color={colors.textStrong}>
              {step.title}
            </T>
            {step.detail && <T color={colors.textSecondary}>{step.detail}</T>}
            {step.action && <View style={styles.stepAction}>{step.action}</View>}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * No Mac to pair yet: a look around with sample agents (lib/demo.ts), said
 * plainly to be samples. Not while a real Mac is paired.
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

function FailureCopy({ failure, mac }: { failure: PairFailure; mac: string }) {
  const colors = useColors();
  const [title, body] = ((): [string, string] => {
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
  })();
  return (
    <>
      <T variant="title" color={colors.textStrong} accessibilityRole="header">
        {title}
      </T>
      <T color={colors.textSecondary}>{body}</T>
    </>
  );
}

const useStyles = makeStyles((colors) => ({
  page: { paddingHorizontal: space.xl, gap: space['2xl'], flexGrow: 1 },
  hero: { gap: space.md },
  logo: { alignSelf: 'flex-start', marginBottom: space.sm },
  block: { gap: space.md },
  card: {
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
    overflow: 'hidden',
  },
  waitingTitle: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  steps: { gap: space.lg },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepNumber: {
    width: iconSize.hero,
    height: iconSize.hero,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  stepDigit: { fontVariant: ['tabular-nums'] },
  stepBody: { flex: 1, gap: space.xs },
  stepAction: { alignSelf: 'flex-start', marginTop: space.xs },
  mono: { fontVariant: ['tabular-nums'], letterSpacing: 1 },
  check: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
