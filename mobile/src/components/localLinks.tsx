/**
 * Links an agent wrote to a server on the Mac (`http://localhost:3400`),
 * which the Mac takes out of the reply (`localLinks`). On the phone such a
 * link would go nowhere, so it is never a link here: a site the Mac knows
 * serves a project gets Watch live (read-only, over the Mac's own tailnet),
 * and anything else is a plain chip saying where it runs.
 */

import { MAC_FEATURES, type LocalLink } from '@shipstudio/companion-protocol';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { haptic } from '../lib/haptics';
import { makeStyles, useColors } from '../lib/appearance';
import { openHere } from '../lib/logins';
import { describeError, watchLive } from '../lib/session';
import { useApp, useServed } from '../lib/store';
import { iconSize, radius, space } from '../lib/theme';
import { TextAction } from './surfaces';
import { Icon, T } from './ui';

/** The Mac hands out Watch live links for a reply's own links. */
export const useCanWatchLinks = () => useServed('agents.watchLive', MAC_FEATURES.watchLinks);

/** "localhost:3400": where it runs, as the chip says it. */
export function localWhere(link: LocalLink): string {
  try {
    return new URL(link.url).host || `localhost:${link.port}`;
  } catch {
    return `localhost:${link.port}`;
  }
}

function Chip({
  link,
  index,
  agentId,
  messageId,
  canWatch,
  onError,
}: {
  link: LocalLink;
  index: number;
  agentId: string;
  messageId: string;
  canWatch: boolean;
  onError: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const connected = useApp((s) => s.link.kind === 'connected');
  const [opening, setOpening] = useState(false);
  const where = localWhere(link);
  const watchable = canWatch && !!link.path;
  const named = link.label && link.label !== where ? link.label : null;
  return (
    <View
      style={styles.chip}
      testID={`local-link-${index}`}
      accessible={!watchable}
      accessibilityLabel={
        watchable ? undefined : `${named ? `${named}, ` : ''}running on your Mac at ${where}`
      }
    >
      <Icon name="desktopcomputer" size={iconSize.body} color={colors.textMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        {named && (
          <T variant="small" color={colors.textPrimary} numberOfLines={1}>
            {named}
          </T>
        )}
        <T variant="caption" color={colors.textMuted} numberOfLines={1}>
          {`Running on your Mac · ${where}`}
        </T>
      </View>
      {watchable && (
        <TextAction
          label={opening ? 'Opening…' : 'Watch live'}
          hint="Opens the site running on your Mac, read-only"
          disabled={!connected || opening}
          onPress={() => {
            haptic.light();
            setOpening(true);
            watchLive(agentId, messageId, index)
              .then((l) => openHere(l.url))
              .catch((e: unknown) => onError(describeError(e)))
              .finally(() => setOpening(false));
          }}
        />
      )}
    </View>
  );
}

export function LocalLinks({
  agentId,
  messageId,
  links,
  onError,
}: {
  agentId: string;
  messageId: string;
  links: LocalLink[];
  onError: (text: string) => void;
}) {
  const canWatch = useCanWatchLinks();
  return (
    <View style={{ gap: space.tight }}>
      {links.map((link, i) => (
        <Chip
          key={`${i}:${link.url}`}
          link={link}
          index={i}
          agentId={agentId}
          messageId={messageId}
          canWatch={canWatch}
          onError={onError}
        />
      ))}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.inner,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceControl,
    alignSelf: 'stretch',
  },
}));
