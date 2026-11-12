/**
 * Every layer of the link, in order, each ok / a problem / unknown. What the
 * phone can't observe is said to be unknown, never guessed.
 */

import { previewText, type Device } from '@shipstudio/companion-protocol';

import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLinkState, useNow } from '../components/ConnectionPill';
import { Button, Dot, Section, T, useToneColor, SheetPage, InsetDivider } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { engineName, failureLine, formatAgo, formatDate } from '../lib/agents';
import { layers, needsPairing, pill, problemBody } from '../lib/connection';
import { appInfo } from '../lib/pairing';
import { reachChecklist } from '../lib/reachChecklist';
import { ReachChecklist, useTailscaleInstalled } from '../components/ReachChecklist';
import { ShowAll } from '../components/ShowAll';
import { currentTransport, deviceSelf, unpair } from '../lib/session';
import { useRouter } from 'expo-router';
import { space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

export default function Connection() {
  const colors = useColors();
  const styles = useStyles();
  const toneColor = useToneColor();
  const now = useNow(5_000);
  const state = useLinkState();
  const [device, setDevice] = useState<Device | null>(null);
  const connected = state.link.kind === 'connected';
  useEffect(() => {
    if (connected) deviceSelf().then(setDevice, () => {});
  }, [connected]);

  const t = currentTransport();
  const p = pill(state, now);
  const rows = layers(
    state,
    { latencyMs: t?.latencyMs ?? null, lastSeenAt: t?.lastSeenAt ?? 0 },
    now
  );
  const failures = (state.overview?.agents ?? []).filter((a) => a.failure);
  const router = useRouter();
  const macName = state.credentials?.name ?? 'your Mac';
  const pairAgain = needsPairing(state.link);
  // The Mac is quiet (not a refusal): the checklist first, the layers folded.
  const unreachable = !connected && state.link.kind !== 'refused';
  const [details, setDetails] = useState(false);
  const installed = useTailscaleInstalled();
  const lastSeenAt = t?.lastSeenAt || state.syncedAt || 0;
  const power = state.mac?.power;
  const checks = unreachable
    ? reachChecklist({
        mac: macName,
        phoneOnline: state.phoneOnline,
        tailscaleInstalled: installed,
        // Paired through the relay only: there's no Tailscale here to check.
        viaTailscale:
          !state.credentials || state.credentials.routes.some((r) => r.kind === 'tailscale'),
        paired: { kind: 'yes', since: state.credentials?.pairedAt ?? 0 },
        lastSeenAt,
        likelyAsleep: !!power && !power.keepAwake && power.onBattery === 'yes',
        now,
      })
    : null;

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.head}>
          <SheetTitle>{state.credentials?.name ?? 'Your Mac'}</SheetTitle>
          <View style={styles.headLine}>
            <Dot color={toneColor[p.tone]} />
            <T variant="small" color={colors.textSecondary}>
              {p.label}
            </T>
          </View>
          {state.refusal && (
            // Removed or asked to pair again: what's true and the fix, in
            // the app's words (the Agents tab's), never the Mac's raw refusal.
            <T variant="small" color={colors.accentErrorLight}>
              {pairAgain ? problemBody(state.link, macName, 'Your agents') : state.refusal.message}
            </T>
          )}
        </View>

        {checks && (
          <Section title="Check these">
            <View style={styles.checklist}>
              <ReachChecklist checks={checks} />
            </View>
          </Section>
        )}

        {unreachable && (
          <ShowAll open={details} onPress={() => setDetails((d) => !d)} label="Details" />
        )}
        {(!unreachable || details) && (
          <Section>
            {rows.map((layer, i) => (
              <View key={layer.title} style={styles.layer}>
                <View style={styles.dot}>
                  <Dot color={toneColor[layer.tone]} />
                </View>
                <View style={{ flex: 1, gap: space['2xs'] }}>
                  <T color={colors.textBody}>{layer.title}</T>
                  <T variant="small" color={colors.textMuted}>
                    {layer.detail}
                  </T>
                </View>
                {i < rows.length - 1 && <InsetDivider />}
              </View>
            ))}
          </Section>
        )}

        {failures.length > 0 && (
          <Section title="Agents">
            {failures.map((a, i) => (
              <View key={a.id} style={styles.layer}>
                <View style={styles.dot}>
                  <Dot
                    color={
                      a.failure?.kind === 'usage_limit' ? colors.accentWarning : colors.accentError
                    }
                  />
                </View>
                <View style={{ flex: 1, gap: space['2xs'] }}>
                  <T color={colors.textBody}>{a.name}</T>
                  <T variant="small" color={colors.textMuted}>
                    {a.failure ? failureLine(a.failure, previewText(a.preview), engineName(a)) : ''}
                    {a.capabilities ? ` · as of ${formatAgo(a.capabilities.seenAt, now)}` : ''}
                  </T>
                </View>
                {i < failures.length - 1 && <InsetDivider />}
              </View>
            ))}
          </Section>
        )}

        <Section title="This phone">
          <Info label="Name" value={device?.name ?? 'Unknown until connected'} />
          <Info
            label="Paired"
            value={state.credentials ? formatDate(state.credentials.pairedAt) : '—'}
          />
          <Info label="App" value={`${appInfo().version} (${appInfo().build})`} last />
        </Section>

        {/* The one fix when the Mac let this phone go: pairing again
            (Tailscale or signing in wouldn't help). A quiet Mac's fixes are in the checklist. */}
        {pairAgain && (
          <Button
            title="Pair again"
            icon="qrcode.viewfinder"
            onPress={async () => {
              await unpair();
              router.replace('/pair');
              router.push('/scan');
            }}
            testID="connection-pair-again"
          />
        )}
      </ScrollView>
    </SheetPage>
  );
}

function Info({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.info}>
      <T color={colors.textBody}>{label}</T>
      <T color={colors.textSecondary} numberOfLines={1} style={{ flexShrink: 1 }}>
        {value}
      </T>
      {!last && <InsetDivider />}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  page: { padding: space.lg, paddingTop: space.xl, gap: space.xs },
  head: { gap: space.tight, marginBottom: space.lg, paddingHorizontal: space.xs },
  headLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  layer: { flexDirection: 'row', gap: space.md, padding: space.lg, alignItems: 'flex-start' },
  // Centred on the title's first line: (24 line − 8 dot) / 2.
  dot: { paddingTop: space.sm },
  info: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, padding: space.lg },
  checklist: { paddingHorizontal: space.lg, paddingVertical: space.xs },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
