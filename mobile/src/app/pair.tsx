/**
 * Welcome and pairing: one Scan button first (with the steps folded under
 * it), then a confirm screen that says which Mac and where, wait for someone
 * at the desk to allow it, then a moment that says which Mac it's paired
 * with, and asks about alerts once if they're undecided. Deep links
 * (`…://pair?d=…`) land here too, and never pair without the confirm: any
 * web page or message can open one.
 */

import { type PairingLink } from '@shipstudio/companion-protocol';
import * as Clipboard from 'expo-clipboard';
import * as Notifications from 'expo-notifications';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, ZoomIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner } from '../components/agent';
import { Button, Icon, T } from '../components/ui';
import { ALERTS_WHILE_OPEN } from '../lib/push';
import {
  cleanName,
  linkHost,
  openTailscale,
  pair,
  PairError,
  pairPlan,
  parseLink,
  type PairFailure,
  type PairPlan,
} from '../lib/pairing';
import { adopt, enableAlerts } from '../lib/session';
import { useApp } from '../lib/store';
import { PAIRING_SCHEME } from '@shipstudio/companion-protocol';
import { haptic } from '../lib/haptics';
import { iconSize, radius, space, squircle } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';
// The placeholder tile (unbranded) until real branding lands.
import icon from '../../assets/splash-icon.png';

type Phase =
  | { kind: 'start'; error?: string }
  /** Say which Mac, where, and what it replaces; nothing is sent until Pair. */
  | { kind: 'confirm'; link: PairingLink; plan: PairPlan }
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

  const begin = useCallback(async (link: PairingLink) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: 'waiting', link });
    try {
      const credentials = await pair(link, controller.signal);
      await adopt(credentials);
      haptic.success();
      // Say which Mac, always; ask about alerts only when there's a decision to make.
      const { status } = await Notifications.getPermissionsAsync().catch(() => ({
        status: Notifications.PermissionStatus.DENIED,
      }));
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
      setPhase({ kind: 'confirm', link, plan: pairPlan(link, current ?? null) });
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
    else setPhase({ kind: 'start', error: notALink });
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
        <Image source={icon} style={styles.logo} />
        <T variant="display" color={colors.textStrong}>
          Your agents, on your phone
        </T>
        <T color={colors.textSecondary}>
          They keep working on your Mac. This phone talks to it directly, over your own Tailscale.
        </T>
      </View>

      {phase.kind === 'start' && (
        <Animated.View entering={FadeIn.duration(200)} style={styles.block}>
          {(phase.error ?? (incoming && !incomingLink ? notALink : null)) && (
            <Animated.View entering={FadeInDown.duration(200)}>
              <T variant="small" color={colors.accentErrorLight}>
                {phase.error ?? notALink}
              </T>
            </Animated.View>
          )}
          <Button
            title="Scan the code on your Mac"
            variant="primary"
            size="large"
            icon="qrcode.viewfinder"
            onPress={() => router.push('/scan')}
          />
          <Button
            title="Paste a pairing link"
            variant="ghost"
            icon="doc.on.clipboard"
            onPress={() => void paste()}
          />
          <View style={styles.steps}>
            <Step n={1} text="On your Mac: Settings → Phone → Pair a phone." />
            <Step n={2} text="Tailscale on here, on the same account as your Mac." />
            <Step n={3} text="Scan, then click Allow on the Mac." />
          </View>
          <T variant="small" color={colors.textMuted}>
            Your Mac has to stay on, with the app open, for this phone to reach it.
          </T>
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
            <Button title="Open Tailscale" icon="network" onPress={() => void openTailscale()} />
          )}
          {phase.failure.kind === 'expired' ||
          phase.failure.kind === 'refused' ||
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

const notALink =
  'That isn’t a pairing link. Make one on your Mac: Settings → Phone → Pair a phone.';

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

function Step({ n, text }: { n: number; text: string }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.step}>
      <View style={styles.stepN}>
        <T variant="caption" color={colors.textPrimary}>
          {n}
        </T>
      </View>
      <T color={colors.textPrimary} style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}

function FailureCopy({ failure, mac }: { failure: PairFailure; mac: string }) {
  const colors = useColors();
  const [title, body] = ((): [string, string] => {
    switch (failure.kind) {
      case 'tailscale_off':
        return [
          'Tailscale isn’t running on this phone',
          `This phone can’t find ${mac} on your tailnet, which usually means Tailscale is off here or signed in to a different tailnet. Turn it on in the Tailscale app, then try again.`,
        ];
      case 'mac_unreachable':
        return [
          `Can’t reach ${mac} on your tailnet`,
          'The Mac didn’t answer. Check that it’s awake, that Tailscale is on there and here, and that the app is open on it.',
        ];
      case 'not_your_mac':
        return [
          'This isn’t your Mac',
          `The server that answered couldn’t prove it’s ${mac}, so this phone didn’t keep what it sent. Make a new code on your Mac and scan it there.`,
        ];
      case 'lan_only':
        return [
          'This code only offers your local network',
          'This version of the app connects over Tailscale. Turn on Tailscale on your Mac, then make a new code in Settings → Phone.',
        ];
      case 'expired':
        return [
          'This code has expired',
          'A code works once and for five minutes. Make a new one on your Mac: Settings → Phone → Pair a phone.',
        ];
      case 'refused':
        return [
          failure.reason === 'denied'
            ? `${mac} said no`
            : failure.reason === 'timeout'
              ? 'Nobody answered on the Mac'
              : failure.reason === 'update_app' || failure.reason === 'update_mac'
                ? 'Update needed'
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

const LOGO = 56;
/** A step's number: a 24pt disc, centred on the step's first 22pt line. */
const STEP = 24;

const useStyles = makeStyles((colors) => ({
  page: { paddingHorizontal: space.xl, gap: space['2xl'], flexGrow: 1 },
  hero: { gap: space.md },
  logo: { width: LOGO, height: LOGO, borderRadius: squircle(LOGO), marginBottom: space.sm },
  block: { gap: space.md },
  steps: { gap: space.md, marginBottom: space.xs },
  step: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  stepN: {
    width: STEP,
    height: STEP,
    borderRadius: STEP / 2,
    backgroundColor: colors.surfaceControl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    padding: space.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.cardBorder,
  },
  waitingTitle: { flexDirection: 'row', alignItems: 'center', gap: space.md },
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
