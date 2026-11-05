/**
 * "What your team needs": every app the agents are waiting on, one row per
 * service, connected once for all of them (`components/teamLogins.tsx`).
 * Every sign-in happens on the Mac; this screen starts it and follows it.
 */

import { ScrollView } from 'react-native';
import { SheetTitle } from '../components/SheetTitle';
import { TeamLoginsList } from '../components/teamLogins';
import { SheetPage, T } from '../components/ui';
import { makeStyles, useColors } from '../lib/appearance';
import { space } from '../lib/theme';

export default function Logins() {
  const colors = useColors();
  const styles = useStyles();
  return (
    <SheetPage>
      <ScrollView contentContainerStyle={styles.root}>
        <SheetTitle>What your team needs</SheetTitle>
        <T color={colors.textSecondary}>
          Each app once, for every agent that asked. Connecting opens the sign-in on your Mac, and
          the sign-in stays there; no password goes through a chat.
        </T>
        <TeamLoginsList />
      </ScrollView>
    </SheetPage>
  );
}

const useStyles = makeStyles(() => ({
  root: { padding: space.lg, paddingTop: space.xl, gap: space.md, paddingBottom: space['2xl'] },
}));
