/** The paired Mac, alerts (with the honest limit), quiet hours, the morning brief, haptics, updates, and about. */

import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Icon, Row, Section, SectionTitle, T, tap } from '../components/ui';
import { GlanceRow } from '../components/usageStack';
import { useGlance } from '../lib/glance';
import { NewAgentDefaults } from '../components/NewAgentDefaults';
import { IndependenceSetting } from '../components/IndependenceSetting';
import { MorningBriefSetting } from '../components/MorningBriefSetting';
import { QuietHoursSetting } from '../components/QuietHoursSetting';
import { formatDate } from '../lib/agents';
import { useAccounts } from '../lib/accounts';
import { AccountsSections } from '../components/accounts';
import { useUsageRows } from '../lib/usagePlan';
import { appInfo } from '../lib/pairing';
import { isDemo } from '../lib/demo';
import { setPref } from '../lib/prefs';
import { ALERTS_WHILE_OPEN, isOfficialBuild, pushLine } from '../lib/push';
import { canCall, enableAlerts, unpair } from '../lib/session';
import { MAC_FEATURES, ON_ITS_OWN_TEAM_TITLE } from '@shipstudio/companion-protocol';
import { useApp, useServed, type AppearancePref } from '../lib/store';
import { useAccent, useSwitchColors } from '../lib/accent';
import { brand } from '../lib/brand';
import { useColors } from '../lib/appearance';
import {
  baseType,
  iconSize,
  lineHeight,
  scaledSize,
  space,
  TEXT_SIZE_KEYS,
  TEXT_SIZES,
  type TextSize,
} from '../lib/theme';

/** The phone's own appearance, or the system's. Named as people say it, not "System". */
const APPEARANCE: { value: AppearancePref; label: string }[] = [
  { value: 'system', label: 'Match this phone' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Settings → Text size: on top of the phone's own Dynamic Type, never instead of it. */
const TEXT_SIZE_LABELS: Record<TextSize, string> = {
  smaller: 'Smaller',
  default: 'Default',
  larger: 'Larger',
  largest: 'Largest',
};

const USAGE_FOOTER =
  'Change it on the Mac in Settings → Accounts & usage, or ask your Chief of Staff. Estimates come from your past runs.';

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string };

export default function Settings() {
  const accent = useAccent();
  const colors = useColors();
  const router = useRouter();
  const servesTeam = useServed('agents.loginsTeam', MAC_FEATURES.logins);
  const servesOnItsOwn = useServed('agents.onItsOwnTeam');
  const servesApps = useServed('agents.apps');
  const canImport = useApp((s) => canCall('agents.import.status', s.welcome));
  const credentials = useApp((s) => s.credentials);
  const demo = isDemo(credentials);
  const connected = useApp((s) => s.link.kind === 'connected');
  // The route in use now, never assumed: nothing while it isn't connected.
  const route = useApp((s) => (s.link.kind === 'connected' ? s.link.route : null));
  const protocol = useApp((s) => s.welcome?.protocol ?? null);
  const haptics = useApp((s) => s.prefs.haptics);
  const appearance = useApp((s) => s.prefs.appearance);
  const textSize = useApp((s) => s.prefs.textSize);
  const hapticsSwitch = useSwitchColors(haptics);
  const voiceRecording = useApp((s) => s.prefs.voiceRecording);
  const recordingSwitch = useSwitchColors(voiceRecording);
  const push = useApp((s) => s.push);
  const pushInfo = pushLine(push, isOfficialBuild());
  const [alerts, setAlerts] = useState<Notifications.PermissionStatus | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' });

  const readAlerts = useCallback(() => {
    Notifications.getPermissionsAsync().then(
      (p) => setAlerts(p.status),
      () => {}
    );
  }, []);
  useEffect(() => {
    readAlerts();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && readAlerts());
    return () => sub.remove();
  }, [readAlerts]);

  const check = async () => {
    setUpdate({ kind: 'checking' });
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) return setUpdate({ kind: 'current' });
      await Updates.fetchUpdateAsync();
      setUpdate({ kind: 'ready' });
    } catch (error) {
      setUpdate({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const macName = credentials?.name ?? 'your Mac';
  // Offline, the Mac can't be told now: say so, and that it's told later.
  const confirmUnpair = () =>
    Alert.alert(
      `Forget ${credentials?.name ?? 'this Mac'}?`,
      connected
        ? 'This phone stops reaching your agents, and the Mac removes it from its paired devices. You can pair again any time.'
        : !credentials?.fingerprint
          ? `This phone stops reaching your agents now. This pairing is from before the app checked your Mac’s identity, so this phone won’t contact ${macName} to remove it: remove it on the Mac, in Settings → Phone.`
          : `This phone stops reaching your agents now. ${macName} can’t be reached, so it keeps this phone in its paired devices until it can: the next time this phone reaches it, it asks the Mac to remove it. You can also remove it on the Mac, in Settings → Phone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: async () => {
            const result = await unpair();
            if (result === 'queued' && connected) {
              Alert.alert(
                'Forgotten on this phone',
                `${macName} didn’t answer, so it still lists this phone. It’s asked again the next time this phone reaches it; or remove it on the Mac, in Settings → Phone.`
              );
            }
            router.replace('/pair');
          },
        },
      ]
    );

  const accounts = useAccounts();
  const usage = useUsageRows();
  // A Mac that serves the whole Usage screen: Settings is one way into it,
  // the same card as the Agents list's, never a second account list in older
  // words (the desk's Settings → Accounts & usage is its Usage view too).
  const glance = useGlance();
  const servesUsage = useApp((s) => canCall('agents.usagePlan', s.welcome));
  const usageCard = servesUsage && glance !== null && glance.keys.length > 0;
  const { version, build } = appInfo();
  const updateLabel =
    update.kind === 'checking'
      ? 'Checking…'
      : update.kind === 'current'
        ? 'Up to date'
        : update.kind === 'ready'
          ? 'Restart to update'
          : update.kind === 'failed'
            ? 'Couldn’t check'
            : undefined;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {demo ? (
        <Section
          title="Demo"
          footer="Sample agents with made-up work. Nothing here reaches a Mac, and nothing is kept."
        >
          <Row
            label="Leave the demo and pair your Mac"
            onPress={() => void unpair().then(() => router.replace('/pair'))}
            last
          />
        </Section>
      ) : (
        <Section title="Paired Mac">
          <Row
            label={credentials?.name ?? 'None'}
            // The state, not the route: which network it goes over is on Connection details.
            value={route ? 'Connected' : undefined}
          />
          {credentials && <Row label="Paired" value={formatDate(credentials.pairedAt)} />}
          <Row label="Connection details" onPress={() => router.push('/connection')} />
          <Row label="Forget this Mac" destructive onPress={confirmUnpair} last />
        </Section>
      )}

      {usageCard ? (
        <View style={styles.usage}>
          <SectionTitle title="Accounts & usage" />
          <GlanceRow glance={glance} onPress={() => router.push('/usage')} />
        </View>
      ) : (
        <>
          <AccountsSections state={accounts} />

          {usage.length > 0 && (
            <Section title="Usage" footer={USAGE_FOOTER}>
              {usage.map((row, i) => (
                <Row
                  key={row.key}
                  label={row.label}
                  value={row.value}
                  detail={row.detail}
                  warning={row.warning}
                  last={i === usage.length - 1}
                />
              ))}
            </Section>
          )}
        </>
      )}

      <IndependenceSetting />
      {servesOnItsOwn && (
        <Section
          title="Without asking"
          footer="Every standing rule, plan and app, in plain words. Taking one away applies at once."
        >
          <Row label={ON_ITS_OWN_TEAM_TITLE} onPress={() => router.push('/on-its-own')} last />
        </Section>
      )}
      <NewAgentDefaults />
      {(servesTeam || servesApps) && (
        <Section
          title="Logins"
          footer="The apps your agents asked for, one row each, and every app connected with who can use it. Sign in from here, or on your Mac."
        >
          {servesTeam && (
            <Row
              label="What your team needs"
              onPress={() => router.push('/logins')}
              last={!servesApps}
            />
          )}
          {servesApps && (
            <Row label="Apps your agents can use" onPress={() => router.push('/apps')} last />
          )}
        </Section>
      )}
      {canImport && (
        <Section title="Bring agents in" footer="From Grok Bot, ChatGPT or any other assistant.">
          <Row label="Import agents" onPress={() => router.push('/import')} last />
        </Section>
      )}

      <Section
        title="Notifications"
        footer={
          pushInfo && alerts === Notifications.PermissionStatus.GRANTED
            ? pushInfo.footer
            : ALERTS_WHILE_OPEN
        }
      >
        <Row
          label="On this phone"
          value={
            alerts === Notifications.PermissionStatus.GRANTED
              ? 'On'
              : alerts === Notifications.PermissionStatus.DENIED
                ? 'Off'
                : 'Not asked yet'
          }
          onPress={() => {
            if (alerts === Notifications.PermissionStatus.UNDETERMINED) {
              void enableAlerts().then(readAlerts);
            } else void Linking.openSettings();
          }}
          last={!pushInfo || alerts !== Notifications.PermissionStatus.GRANTED}
        />
        {pushInfo && alerts === Notifications.PermissionStatus.GRANTED && (
          <Row label="When the app is closed" value={pushInfo.value} last />
        )}
      </Section>

      <QuietHoursSetting />

      <MorningBriefSetting />

      <Section title="Appearance">
        {APPEARANCE.map((o, i) => {
          const on = o.value === appearance;
          return (
            <Row
              key={o.value}
              label={o.label}
              selected={on}
              onPress={() => {
                if (on) return;
                tap();
                setPref('appearance', o.value);
              }}
              trailing={
                on ? (
                  <Icon name="checkmark" size={iconSize.body} color={accent.accent} />
                ) : (
                  <View style={styles.check} />
                )
              }
              last={i === APPEARANCE.length - 1}
            />
          );
        })}
      </Section>

      <Section
        title="Text size"
        footer="Replies, cards and lists, on top of the Text Size you set for this phone in iOS Settings."
      >
        {TEXT_SIZE_KEYS.map((key, i) => {
          const on = key === textSize;
          return (
            <Row
              key={key}
              label={TEXT_SIZE_LABELS[key]}
              selected={on}
              onPress={() => {
                if (on) return;
                tap();
                setPref('textSize', key);
              }}
              trailing={
                <View style={styles.sizeTrail}>
                  {/* Each step drawn at its own size: the choice reads before it's made. */}
                  <T
                    variant="body"
                    color={colors.textSecondary}
                    style={{
                      fontSize: scaledSize(baseType.body, TEXT_SIZES[key]),
                      lineHeight: lineHeight(scaledSize(baseType.body, TEXT_SIZES[key])),
                    }}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  >
                    Aa
                  </T>
                  {on ? (
                    <Icon name="checkmark" size={iconSize.body} color={accent.accent} />
                  ) : (
                    <View style={styles.check} />
                  )}
                </View>
              }
              last={i === TEXT_SIZE_KEYS.length - 1}
            />
          );
        })}
      </Section>

      <Section
        title="Feel"
        footer="A tap when you send, stop, answer an approval, or something fails. Never for just moving around."
      >
        <Row
          label="Haptics"
          trailing={
            <Switch
              value={haptics}
              onValueChange={(on) => setPref('haptics', on)}
              {...hapticsSwitch}
              accessibilityLabel="Haptics"
            />
          }
          last
        />
      </Section>

      <Section
        title="Voice"
        footer={`Hold the mic to send a voice message: let go to send, slide away to cancel. Your words are recognised on this phone when it can. With this on, the recording goes to ${macName} with them, as a file the agent can keep; it’s deleted from this phone once sent.`}
      >
        <Row
          label="Attach the recording"
          trailing={
            <Switch
              value={voiceRecording}
              onValueChange={(on) => setPref('voiceRecording', on)}
              {...recordingSwitch}
              accessibilityLabel="Attach the recording to voice messages"
            />
          }
          last
        />
      </Section>

      <Section
        title="Updates"
        footer={
          Updates.isEnabled
            ? 'Updates download in the background and apply the next time the app starts.'
            : 'Over-the-air updates are off in this build (a development or self-built app). Reinstall it from your Mac to update.'
        }
      >
        {/* One row: the build's details are for a bug report, a tap away. */}
        <Row
          label="Version"
          value={`${version} (${build})`}
          onPress={() =>
            Alert.alert(
              `Version ${version} (${build})`,
              [
                `Runtime ${Updates.runtimeVersion ?? 'development'}`,
                Updates.channel ? `Channel ${Updates.channel}` : null,
                Updates.updateId ? `Update ${Updates.updateId.slice(0, 8)}` : null,
                protocol != null ? `Connection protocol ${protocol}` : null,
              ]
                .filter(Boolean)
                .join('\n')
            )
          }
          last={!Updates.isEnabled}
        />
        {Updates.isEnabled && (
          <Row
            label={update.kind === 'ready' ? 'Restart to update' : 'Check for update'}
            value={update.kind === 'ready' ? undefined : updateLabel}
            onPress={() => (update.kind === 'ready' ? void Updates.reloadAsync() : void check())}
            last
          />
        )}
      </Section>
      {update.kind === 'failed' && (
        <T variant="small" color={colors.accentErrorLight} style={styles.error}>
          {update.message}
        </T>
      )}

      {!!brand.repository && (
        <Section title="About">
          <Row
            label="Source code"
            value="GitHub"
            onPress={() => void Linking.openURL(brand.repository)}
            last
          />
        </Section>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.lg },
  usage: { marginBottom: space.xl },
  check: { width: 16 },
  sizeTrail: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  error: { marginHorizontal: space.lg, marginTop: -space.md, marginBottom: space.lg },
});

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
