/**
 * Under the chat's header, once an agent has more than one conversation:
 * which one is on screen, and a dot when another waits on you. A tap opens
 * the agent's conversations (app/conversations.tsx).
 */

import {
  conversationTitle,
  othersWaiting,
  type Conversations,
} from '@shipstudio/companion-protocol';
import { Pressable, StyleSheet, View } from 'react-native';
import { Dot, Icon, T } from './ui';
import { PRESSED, iconSize, space } from '../lib/theme';
import { makeStyles, useColors } from '../lib/appearance';

export function ConversationSwitch({
  list,
  viewing,
  onPress,
}: {
  list: Conversations;
  viewing: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const title = conversationTitle(
    list.items.find((c) => c.id === viewing) ?? { id: viewing, title: '' }
  );
  const waiting = othersWaiting(list, viewing);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Conversation: ${title}`}
      accessibilityHint={
        waiting > 0
          ? 'Another conversation needs your OK. Opens the conversations.'
          : 'Opens the conversations'
      }
      onPress={onPress}
      style={({ pressed }) => [styles.bar, pressed && PRESSED]}
    >
      <Icon name="bubble.left" size={iconSize.inline} color={colors.textMuted} />
      <T variant="small" color={colors.textSecondary} numberOfLines={1} style={styles.title}>
        {title}
      </T>
      {waiting > 0 && <Dot color={colors.accentWarning} glow />}
      <View>
        <Icon name="chevron.down" size={iconSize.inline} color={colors.textMuted} />
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDefault,
  },
  title: { flexShrink: 1 },
}));
