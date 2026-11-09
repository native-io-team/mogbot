/**
 * Import agents from another assistant (Grok, ChatGPT, Claude…), from the
 * phone (desktop `agents/connector.rs`, docs/agents.md "Import").
 *
 * Three steps, one screen at a time (`phoneImportStep`), each said plainly:
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
 *
 * Without Remote access, a Mac with `import.export` also takes a reply pasted
 * here (`ImportPaste`): it ends on the same review card in the Chief's chat.
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
import { phoneImportStep } from '../lib/importChoice';
import { ImportPaste } from '../components/ImportPaste';

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
  const servesPaste = useServed('agents.import.exportReview', MAC_FEATURES.importExport);
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

  const talk = status?.talk ?? null;
  const going = live(talk);
  const armed = !!status?.armed;
  const openChief = () => {
    const id = status?.chiefId ?? chief?.id;
    if (id) router.replace({ pathname: '/chat/[id]', params: { id } });
  };

  const step = phoneImportStep(status);

  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.root}>
        <SheetTitle>Import agents</SheetTitle>
        <T variant="caption" color={colors.textMuted} testID="import-progress">
          Step {step.index} of 3
        </T>

        {step.id === 'connect' && (
          <View style={styles.step}>
            <T variant="headline" color={colors.textStrong}>
              {!status
                ? 'Checking your Mac…'
                : !step.reachable
                  ? `Turn on Remote access at ${macName}`
                  : 'Add the link to your assistant'}
            </T>
            <T color={colors.textSecondary}>
              {!status
                ? connected
                  ? `Asking ${macName}…`
                  : `Needs ${macName}.`
                : !step.reachable
                  ? `Once, at ${macName}: press ⌘K → Import agents and follow its first step. This screen ticks when it’s on.`
                  : `Once, at ${macName}: press Copy link and add it to your assistant as a connector. The link is a key, so it never comes to this phone. This ticks when your assistant connects.`}
            </T>
            {status && <TypingDots color={colors.textMuted} />}
          </View>
        )}
        {step.id === 'connect' && servesPaste && connected && (
          <ImportPaste
            chiefName={chiefName}
            onPosted={(id) => router.replace({ pathname: '/chat/[id]', params: { id } })}
          />
        )}

        {step.id === 'start' && (
          <View style={styles.step}>
            <T variant="headline" color={colors.textStrong}>
              Send your assistant this message
            </T>
            {armed ? (
              <>
                <T variant="small" color={colors.textBody}>
                  {status?.prompt}
                </T>
                <Button
                  title={copied ? 'Copied' : 'Copy message'}
                  variant="answer"
                  size="large"
                  icon="doc.on.doc"
                  onPress={() => {
                    void Clipboard.setStringAsync(status?.prompt ?? '').then(() => {
                      setCopied(true);
                      haptic.success();
                    });
                  }}
                />
                <T variant="caption" color={colors.textSecondary}>
                  Paste it into a new chat with your assistant and send it. It holds no keys or
                  passwords.
                </T>
              </>
            ) : (
              <>
                <T color={colors.textSecondary}>
                  Start lets one import begin, until it ends or {macName} quits.
                </T>
                <Button
                  title="Start"
                  variant="answer"
                  size="large"
                  busy={busy}
                  disabled={!connected || busy}
                  onPress={() => void act('agents.import.start')}
                />
              </>
            )}
          </View>
        )}

        {step.id === 'follow' && talk && (
          <View style={styles.step}>
            <T variant="headline" color={colors.textStrong}>
              {talk.state === 'imported' ? 'Done' : `Answer ${chiefName} in its chat`}
            </T>
            {talk.state === 'interviewing' ? (
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
              <T variant="small" color={colors.textBody}>
                {phoneTalkLine(talk, chiefName)}
              </T>
            )}
            {(chief || status?.chiefId) && (
              <Button
                title={`Open ${chiefName}`}
                variant={going ? 'answer' : 'outline'}
                size="large"
                onPress={openChief}
              />
            )}
            {talk.state === 'imported' && talk.imported.length > 0 && servesTeam && (
              <Button
                title="Give them what they need"
                variant="answer"
                icon="person.2"
                onPress={() => router.push('/logins')}
              />
            )}
          </View>
        )}

        {(armed || going) && (
          <Button
            title={going ? 'Stop import' : 'Cancel'}
            variant="ghost"
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

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
