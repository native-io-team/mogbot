/**
 * Welcome and pairing: one Scan button first (with the steps folded under
 * it), wait for someone at the desk to allow it, then a moment that says
 * which Mac it's paired with, and asks about alerts once if they're undecided.
 * Deep links (`…://pair?d=…`) land here too.
 */

import { parsePairingLink, type PairingLink } from '@shipstudio/companion-protocol';
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
import { openTailscale, pair, PairError, type PairFailure } from '../lib/pairing';
import { adopt, enableAlerts } from '../lib/session';
import { PAIRING_SCHEME } from '@shipstudio/companion-protocol';
import { haptic } from '../lib/haptics';
import { colors, radius, space } from '../lib/theme';
import icon from '../../assets/icon.png';

type Phase =
  | { kind: 'start'; error?: string }
  | { kind: 'waiting'; link: PairingLink }
  | { kind: 'failed'; link: PairingLink; failure: PairFailure }
  | { kind: 'paired'; mac: string; askAlerts: boolean };

/** How long the success moment stays when there's nothing to decide on it. */
const PAIRED_MS = 1600;

export default function Pair() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ d?: string; link?: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'start' });
  const abort = useRef<AbortController | null>(null);

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

  // Arrived with a link (deep link, or the scanner).
  const incoming = params.link ?? (params.d ? `${PAIRING_SCHEME}://pair?d=${params.d}` : null);
  const incomingLink = incoming ? parsePairingLink(incoming) : null;
  useEffect(() => {
    if (incomingLink) void begin(incomingLink);
    // Keyed on the text: a parsed link is a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, begin]);

  useEffect(() => () => abort.current?.abort(), []);

  const paste = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    const link = parsePairingLink(text);
    if (link) void begin(link);
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
        <T variant="display" color={colors.textWhite}>
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

      {phase.kind === 'waiting' && (
        <Animated.View
          entering={FadeInDown.duration(250)}
          exiting={FadeOut.duration(150)}
          style={[styles.card, styles.block]}
        >
          <View style={styles.waitingTitle}>
            <Spinner size={14} color={colors.textPrimary} />
            <T variant="title" color={colors.textWhite}>
              Allow on your Mac
            </T>
          </View>
          <T color={colors.textSecondary}>
            {phase.link.name} is asking whether to let this phone use your agents. Click Allow
            there. This waits up to two minutes.
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
          <FailureCopy failure={phase.failure} mac={phase.link.name} />
          {(phase.failure.kind === 'tailscale_off' || phase.failure.kind === 'mac_unreachable') && (
            <Button title="Open Tailscale" icon="network" onPress={() => void openTailscale()} />
          )}
          {phase.failure.kind === 'expired' || phase.failure.kind === 'refused' ? (
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
            <Icon name="checkmark" size={22} color={colors.accentSuccess} fallback={<T>✓</T>} />
          </Animated.View>
          <T variant="title" color={colors.textWhite} accessibilityRole="header">
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

function Step({ n, text }: { n: number; text: string }) {
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
      <T variant="title" color={colors.textWhite}>
        {title}
      </T>
      <T color={colors.textSecondary}>{body}</T>
    </>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: space.xl, gap: space['2xl'], flexGrow: 1 },
  hero: { gap: space.md },
  logo: { width: 56, height: 56, borderRadius: 13, marginBottom: space.sm },
  block: { gap: space.md },
  steps: { gap: space.md, marginBottom: space.xs },
  step: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  stepN: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.surfaceControl,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  card: {
    padding: space.xl,
    borderRadius: radius.lg + 4,
    backgroundColor: colors.surfacePanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  waitingTitle: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  check: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
});
