/** The paired Mac, alerts (with the honest limit), haptics, updates, and about. */

import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Icon, Row, Section, T, tap } from '../components/ui';
import { useQuotaLines } from '../lib/quota';
import { appInfo } from '../lib/pairing';
import { setPref } from '../lib/prefs';
import { ALERTS_WHILE_OPEN, isOfficialBuild, pushLine } from '../lib/push';
import { enableAlerts, unpair } from '../lib/session';
import { useApp, type AppearancePref } from '../lib/store';
import { useAccent, useSwitchColors } from '../lib/accent';
import { brand } from '../lib/brand';
import { useColors } from '../lib/appearance';
import { iconSize, space } from '../lib/theme';

/** The phone's own appearance, or the system's. Named as people say it, not "System". */
const APPEARANCE: { value: AppearancePref; label: string }[] = [
  { value: 'system', label: 'Match this phone' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

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
  const credentials = useApp((s) => s.credentials);
  const connected = useApp((s) => s.link.kind === 'connected');
  // The route in use now, never assumed: nothing while it isn't connected.
  const route = useApp((s) => (s.link.kind === 'connected' ? s.link.route : null));
  const protocol = useApp((s) => s.welcome?.protocol ?? null);
  const haptics = useApp((s) => s.prefs.haptics);
  const appearance = useApp((s) => s.prefs.appearance);
  const hapticsSwitch = useSwitchColors(haptics);
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

  const quota = useQuotaLines();
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
      <Section title="Paired Mac">
        <Row
          label={credentials?.name ?? 'None'}
          value={
            route === 'tailscale'
              ? 'Over Tailscale'
              : route === 'lan'
                ? 'On this network'
                : undefined
          }
        />
        {credentials && (
          <Row label="Paired" value={new Date(credentials.pairedAt).toLocaleDateString()} />
        )}
        <Row label="Connection details" onPress={() => router.push('/connection')} />
        <Row label="Forget this Mac" destructive onPress={confirmUnpair} last />
      </Section>

      {quota.length > 0 && (
        <Section title="Plan usage">
          {quota.map((line, i) => (
            <Row
              key={line.engine}
              label={line.text}
              detail={line.detail}
              last={i === quota.length - 1}
            />
          ))}
        </Section>
      )}

      <Section
        title="Alerts"
        footer={
          pushInfo && alerts === Notifications.PermissionStatus.GRANTED
            ? pushInfo.footer
            : ALERTS_WHILE_OPEN
        }
      >
        <Row
          label="Alerts"
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
  check: { width: 16 },
  error: { marginHorizontal: space.lg, marginTop: -space.md, marginBottom: space.lg },
});
