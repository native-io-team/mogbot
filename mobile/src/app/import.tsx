/**
 * Import agents from another assistant (Grok, ChatGPT, Claude…), from the
 * phone (desktop `agents/connector.rs`, docs/agents.md "Import").
 *
 * Three steps, each said plainly:
 * 1. **Remote access on, and the assistant connected.** Done once, at the
 *    Mac: Remote access gets this app's own address (beside any other app's
 *    mount on the same Funnel), and its link is added to the assistant as a
 *    connector. The link is a key, so it never comes to this phone: the Mac
 *    copies it (docs/remote-access.md, "Security"). This screen says exactly
 *    what to do there, and ticks when the Mac reports it.
 * 2. **Start, then send the message.** Start asks the Mac to allow one
 *    import; the message (no secrets in it) is copied here, to paste into
 *    the assistant.
 * 3. **Follow it in the Chief's chat.** The consent card, the plan played
 *    back ("anything I'm missing?") and the review card are all answerable
 *    there, from this phone.
 */

import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import type { ImportTalk, PhoneImportStatus } from '@shipstudio/companion-protocol';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, SheetPage, T } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { makeStyles, useColors } from '../lib/appearance';
import { haptic } from '../lib/haptics';
import { call, describeError } from '../lib/session';
import { MAC_FEATURES } from '@shipstudio/companion-protocol';
import { useApp, useServed } from '../lib/store';
import { space, typingDot } from '../lib/theme';
import { TypingDots } from '../components/TypingDots';

/** How often the screen asks the Mac where the import has got to. */
const POLL_MS = 3000;

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** Where an import has got to, in one line (the desk's `talkLine`). */
export function phoneTalkLine(talk: ImportTalk, chief: string): string {
  switch (talk.state) {
    case 'awaiting_consent':
      return `${talk.source} is asking to start: allow it in ${chief}’s chat`;
    case 'interviewing':
      // The counts go on their own line (`importCounts`), so this one never grows.
      return `${talk.source} is telling ${chief} what each agent does`;
    case 'playback':
      return `${chief} is playing back the plan: tell it what’s missing`;
    case 'review':
      return `${plural(talk.staged.length, 'agent')} ready to import in ${chief}’s chat`;
    case 'imported':
      return talk.imported.length ? `Imported ${talk.imported.join(', ')}` : 'Nothing was imported';
    case 'declined':
      return 'You chose not to import them. Nothing was created';
    case 'denied':
      return `You declined ${talk.source}. Nothing was shared`;
    default:
      return `The import from ${talk.source} stopped. Nothing was created`;
  }
}

/**
 * The interview's progress in real counts (the desk's `importCounts`), or
 * null before there are any. Counts, not names, so the line holds still as
 * agents arrive; never a percentage, since nothing knows how many are to come.
 */
export function importCounts(talk: ImportTalk): string | null {
  const parts = [
    talk.staged.length ? `${plural(talk.staged.length, 'agent')} staged` : null,
    talk.conversations ? plural(talk.conversations, 'conversation') : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

const live = (t: ImportTalk | null) =>
  !!t && ['awaiting_consent', 'interviewing', 'playback', 'review'].includes(t.state);

export default function ImportScreen() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const connected = useApp((s) => s.link.kind === 'connected');
  const servesTeam = useServed('agents.loginsTeam', MAC_FEATURES.logins);
  const macName = useApp((s) => s.credentials?.name ?? 'your Mac');
  const chief = useApp((s) => s.overview?.agents.find((a) => a.isMain));
  const chiefName = chief?.name ?? 'Chief of Staff';
  const [status, setStatus] = useState<PhoneImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call('agents.import.status', {}));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);
  useEffect(() => {
    if (!connected) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [connected, refresh]);

  const act = async (method: 'agents.import.start' | 'agents.import.stop') => {
    setBusy(true);
    try {
      setStatus(await call(method, {}));
      setError(null);
      haptic.success();
    } catch (e) {
      haptic.error();
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const remote = status?.remoteAccess;
  const reachable = !!remote?.enabled && !!remote.funnelOn;
  const talk = status?.talk ?? null;
  const going = live(talk);
  const armed = !!status?.armed;
  const openChief = () => {
    const id = status?.chiefId ?? chief?.id;
    if (id) router.replace({ pathname: '/chat/[id]', params: { id } });
  };

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.root}>
        <SheetTitle>Import agents</SheetTitle>
        <T color={colors.textSecondary}>
          Bring the agents another assistant runs for you (like Grok). It tells {chiefName}{' '}
          everything each agent does; {chiefName} plays it back to you, and you choose what to
          import.
        </T>

        <View style={styles.step}>
          <T variant="headline" color={colors.textStrong}>
            1. Connect your assistant {reachable && remote?.everConnected ? '✓' : ''}
          </T>
          {!status ? (
            <T variant="small" color={colors.textSecondary}>
              {connected ? `Asking ${macName}…` : `Needs ${macName}.`}
            </T>
          ) : !reachable ? (
            <T variant="small" color={colors.textSecondary}>
              Once, at {macName}: open Settings → Remote access and turn it on. This app gets its
              own address, so another app’s Remote access keeps working beside it.
            </T>
          ) : !remote?.everConnected ? (
            <T variant="small" color={colors.textSecondary}>
              Once, at {macName}: in Remote access press Copy link, and add it to your assistant as
              a connector. The link is a key to {macName}, so it never comes to this phone.
            </T>
          ) : (
            <T variant="small" color={colors.textSecondary}>
              Remote access is on and your assistant has connected.
            </T>
          )}
        </View>

        <View style={styles.step}>
          <T variant="headline" color={colors.textStrong}>
            2. Start, then send it this message
          </T>
          {going ? (
            <T variant="small" color={colors.textSecondary}>
              Sent. {talk?.source} is talking to {chiefName}.
            </T>
          ) : armed ? (
            <>
              <T variant="small" color={colors.textBody}>
                {status?.prompt}
              </T>
              <Button
                title={copied ? 'Copied' : 'Copy message'}
                variant="answer"
                icon="doc.on.doc"
                onPress={() => {
                  void Clipboard.setStringAsync(status?.prompt ?? '').then(() => {
                    setCopied(true);
                    haptic.success();
                  });
                }}
              />
              <T variant="caption" color={colors.textSecondary}>
                Paste it into your assistant. It holds no keys or passwords.
              </T>
            </>
          ) : (
            <>
              <T variant="small" color={colors.textSecondary}>
                Start lets one import begin, until it ends or {macName} quits.
              </T>
              <Button
                title="Start"
                variant="answer"
                busy={busy}
                disabled={!connected || busy || !reachable}
                onPress={() => void act('agents.import.start')}
              />
            </>
          )}
        </View>

        <View style={styles.step}>
          <T variant="headline" color={colors.textStrong}>
            3. Allow it, check the plan, import
          </T>
          {talk?.state === 'interviewing' ? (
            // Going on now: the typing dots, one line of what, one of how far.
            <View style={styles.live} accessible accessibilityLiveRegion="polite">
              <View style={styles.liveRow}>
                <TypingDots color={colors.statusRunning} />
                <T variant="small" color={colors.textBody} style={styles.flex}>
                  {phoneTalkLine(talk, chiefName)}
                </T>
              </View>
              {importCounts(talk) && (
                <T variant="caption" color={colors.textSecondary} style={styles.counts}>
                  {importCounts(talk)}
                </T>
              )}
            </View>
          ) : (
            <T variant="small" color={going ? colors.textBody : colors.textSecondary}>
              {talk
                ? phoneTalkLine(talk, chiefName)
                : `${chiefName} asks you first, then tells you what each agent will do and asks what’s missing. You answer here or on ${macName}.`}
            </T>
          )}
          {(chief || status?.chiefId) && (
            <Button title={`Open ${chiefName}`} variant="outline" onPress={openChief} />
          )}
          {talk?.state === 'imported' && talk.imported.length > 0 && servesTeam && (
            <Button
              title="Give them what they need"
              variant="answer"
              icon="person.2"
              onPress={() => router.push('/logins')}
            />
          )}
        </View>

        {(armed || going) && (
          <Button
            title={going ? 'Stop import' : 'Cancel'}
            variant="outline"
            busy={busy}
            disabled={!connected || busy}
            onPress={() => void act('agents.import.stop')}
          />
        )}
        {error && (
          <T variant="caption" color={colors.textSecondary}>
            {error}
          </T>
        )}
      </ScrollView>
    </SheetPage>
  );
}

const useStyles = makeStyles(() => ({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.lg, paddingBottom: space['2xl'] },
  step: { gap: space.sm },
  live: { gap: space['2xs'] },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
  // Lines up under the words, past the dots; numbers don't shift as they tick.
  counts: {
    fontVariant: ['tabular-nums'],
    paddingLeft: typingDot.size * 3 + typingDot.gap * 2 + space.sm,
  },
}));
