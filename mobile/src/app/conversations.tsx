/**
 * An agent's conversations, from its chat's header: New conversation, a
 * search, every conversation newest first (which one is on screen, which
 * waits on you, which it's working in), and Rename for the one on screen.
 * Each has its own session and chat; its instructions and memory are shared
 * by all of them (docs/mobile.md, "Conversations"). Picking one goes back to
 * the chat, showing it.
 */

import {
  conversationTitle,
  filterConversations,
  CONVERSATION_TITLE_CHARS,
  type ConversationView,
} from '@shipstudio/companion-protocol';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Button, Icon, Row, SheetPage, T } from '../components/ui';
import { SheetTitle } from '../components/SheetTitle';
import { haptic } from '../lib/haptics';
import {
  describeError,
  newConversation,
  openConversation,
  refreshConversations,
  renameConversation,
} from '../lib/session';
import { useApp } from '../lib/store';
import { useAccent } from '../lib/accent';
import { withAgentAccent } from '../lib/accentScreen';
import { formatAgo } from '../lib/agents';
import { fonts, iconSize, radius, space, type } from '../lib/theme';
import { makeStyles, useAppearance, useColors } from '../lib/appearance';

export default withAgentAccent(ConversationsSheet);

function ConversationsSheet() {
  const colors = useColors();
  const styles = useStyles();
  const appearance = useAppearance();
  const accent = useAccent();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useApp((s) => s.overview?.agents.find((a) => a.id === id));
  const list = useApp((s) => s.conversations[id]);
  const viewing = useApp((s) => s.viewing[id] ?? s.conversations[id]?.current);
  const connected = useApp((s) => s.link.kind === 'connected');
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (connected) refreshConversations(id).catch((e: unknown) => setError(describeError(e)));
  }, [connected, id]);

  const items = useMemo(() => filterConversations(list?.items ?? [], query), [list, query]);
  const current = list?.items.find((c) => c.id === viewing);
  const working =
    agent && agent.status.state !== 'idle' && !agent.status.room
      ? (agent.conversations?.loaded ?? 'first')
      : null;

  const run = (work: () => Promise<unknown>, back = true) => {
    setBusy(true);
    setError(null);
    work()
      .then(() => {
        haptic.success();
        // Back to the chat, showing it (opened on its own, by a link: to the chat).
        if (back) {
          if (router.canGoBack()) router.back();
          else router.replace({ pathname: '/chat/[id]', params: { id } });
        }
      })
      .catch((e: unknown) => {
        haptic.error();
        setError(describeError(e));
      })
      .finally(() => setBusy(false));
  };

  const detail = (c: ConversationView) =>
    c.waiting > 0
      ? 'Needs your OK'
      : c.id === working
        ? 'Working'
        : c.lastActivityAt > 0
          ? formatAgo(c.lastActivityAt, now)
          : undefined;

  return (
    <SheetPage>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <SheetTitle>Conversations</SheetTitle>
        <T variant="small" color={colors.textSecondary}>
          Each has its own chat. {agent?.name ?? 'It'} remembers the same things in all of them.
        </T>
        {error && (
          <T variant="small" color={colors.accentErrorLight}>
            {error}
          </T>
        )}
        <View style={styles.list}>
          <Row
            label="New conversation"
            leading={<Icon name="plus" size={iconSize.body} color={accent.accent} />}
            onPress={() => run(() => newConversation(id))}
            disabled={!connected || busy}
            detail={connected ? undefined : 'Available once your Mac is connected'}
            last
          />
        </View>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Find a conversation"
          placeholderTextColor={colors.textMuted}
          keyboardAppearance={appearance}
          selectionColor={accent.accent}
          accessibilityLabel="Find a conversation"
          autoCorrect={false}
          style={styles.input}
        />
        <View style={styles.list}>
          {items.length === 0 && (
            <T variant="small" color={colors.textMuted} style={styles.none}>
              {list ? 'No conversation matches.' : 'Reading conversations…'}
            </T>
          )}
          {items.map((c, i) => (
            <Row
              key={c.id}
              label={conversationTitle(c)}
              detail={detail(c)}
              selected={c.id === viewing}
              warning={c.waiting > 0}
              trailing={
                c.id === viewing ? (
                  <Icon name="checkmark" size={iconSize.body} color={accent.accent} />
                ) : undefined
              }
              onPress={() => run(() => openConversation(id, c.id))}
              disabled={!connected || busy}
              last={i === items.length - 1}
            />
          ))}
        </View>
        {current &&
          (renaming === null ? (
            <Button
              title="Rename this conversation"
              variant="ghost"
              size="compact"
              disabled={!connected}
              onPress={() => setRenaming(current.title ? conversationTitle(current) : '')}
            />
          ) : (
            <View style={styles.rename}>
              <TextInput
                autoFocus
                value={renaming}
                onChangeText={setRenaming}
                maxLength={CONVERSATION_TITLE_CHARS}
                placeholder="Named by its first message"
                placeholderTextColor={colors.textMuted}
                keyboardAppearance={appearance}
                selectionColor={accent.accent}
                accessibilityLabel="Conversation name"
                style={styles.input}
              />
              <T variant="small" color={colors.textMuted}>
                Leave it empty to name it by its first message again.
              </T>
              <View style={styles.actions}>
                <Button
                  title="Cancel"
                  size="compact"
                  variant="ghost"
                  onPress={() => setRenaming(null)}
                />
                <Button
                  title="Rename"
                  size="compact"
                  variant="primary"
                  busy={busy}
                  disabled={!connected}
                  onPress={() =>
                    run(
                      () =>
                        renameConversation(id, current.id, renaming.trim()).then(() =>
                          setRenaming(null)
                        ),
                      false
                    )
                  }
                />
              </View>
            </View>
          ))}
      </KeyboardAwareScrollView>
    </SheetPage>
  );
}

const useStyles = makeStyles((colors) => ({
  content: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
  list: { backgroundColor: colors.surfaceGroup, borderRadius: radius.card, overflow: 'hidden' },
  none: { padding: space.lg },
  input: {
    minHeight: 44,
    fontFamily: fonts.regular,
    fontSize: type.body,
    color: colors.textBody,
    backgroundColor: colors.inputFill,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.inputBorder,
    paddingHorizontal: space.md,
    paddingVertical: 0,
  },
  rename: { gap: space.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
}));

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
