/**
 * "What can it do on its own?" (`components/onItsOwn`): one agent's, from
 * its sheet (`id`), or the team's, from Settings (no `id`), whose rows open
 * an agent's here.
 */

import { onItsOwnTitle, ON_ITS_OWN_TEAM_TITLE } from '@shipstudio/companion-protocol';
import { useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';
import { SheetTitle } from '../components/SheetTitle';
import { OnItsOwnList, OnItsOwnTeamList } from '../components/onItsOwn';
import { SheetPage } from '../components/ui';
import { withAgentAccent } from '../lib/accentScreen';
import { useApp } from '../lib/store';
import { space } from '../lib/theme';

export default withAgentAccent(OnItsOwnScreen);

function OnItsOwnScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const name = useApp((s) => s.overview?.agents.find((a) => a.id === id)?.name ?? 'This agent');
  return (
    <SheetPage>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xl, gap: space.md }}>
        <SheetTitle numberOfLines={2}>{id ? onItsOwnTitle(name) : ON_ITS_OWN_TEAM_TITLE}</SheetTitle>
        {id ? <OnItsOwnList agentId={id} /> : <OnItsOwnTeamList />}
      </ScrollView>
    </SheetPage>
  );
}

/** A throw while drawing stays on this screen, with the way back. */
export { ScreenError as ErrorBoundary } from '../components/ScreenError';
