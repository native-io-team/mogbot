/**
 * The three places you go from home: your agents, the projects they work
 * in, and search across every conversation. Native tabs, so the bar is the
 * system's own (Liquid Glass on iOS 26) and search is the system search tab.
 */

import { NativeTabs } from 'expo-router/native-tabs';
import { attentionCounts } from '../../lib/agents';
import { useApp } from '../../lib/store';
import { useColors } from '../../lib/appearance';

export default function TabsLayout() {
  const colors = useColors();
  // Counts only, so a streaming reply never re-renders the tab bar. A count
  // is live news, so it shows only while the Mac is answering: offline the
  // rows say "as of …", and a red number would claim more than is known.
  const live = useApp((s) => s.link.kind === 'connected');
  // The same number as Home's "N agents need your OK" and every count on the desk.
  const waiting = useApp((s) =>
    s.overview ? attentionCounts(s.overview.agents, s.teamSetup).needYou : 0
  );
  const asking = useApp(
    (s) =>
      s.projects?.reduce(
        (n, p) => n + p.sessions.filter((x) => x.state === 'needs_decision').length,
        0
      ) ?? 0
  );
  return (
    <NativeTabs tintColor={colors.textStrong} iconColor={{ default: colors.textMuted }}>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
          md="forum"
        />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        {live && waiting > 0 && (
          <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge>
        )}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="projects">
        <NativeTabs.Trigger.Icon sf={{ default: 'folder', selected: 'folder.fill' }} md="folder" />
        <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        {/* Rendered only when there's a count: a hidden badge could linger as "0". */}
        {live && asking > 0 && (
          <NativeTabs.Trigger.Badge>{String(asking)}</NativeTabs.Trigger.Badge>
        )}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
