/**
 * The places you go from home: Catch up (what needs you), your agents, the projects
 * they work in, and search across every conversation. Native tabs, so the bar is the
 * system's own (Liquid Glass on iOS 26) and search is the system search tab.
 */

import { NativeTabs } from 'expo-router/native-tabs';
import { useLanding } from '../../lib/landing';
import { feedItems } from '../../lib/needsYou';
import { canCall } from '../../lib/session';
import { useApp } from '../../lib/store';
import { useColors } from '../../lib/appearance';

export default function TabsLayout() {
  const colors = useColors();
  // Catch up when something waits on you, else Agents: at launch and on
  // coming back after a while, never mid-use (lib/landing.ts).
  useLanding();
  // Counts only, so a streaming reply never re-renders the tab bar. A count
  // is live news, so it shows only while the Mac is answering: offline the
  // rows say "as of …", and a red number would claim more than is known.
  const live = useApp((s) => s.link.kind === 'connected');
  // What the tab lists, counted: one per row (a card, changes to keep, a
  // turn to fix), so the number always matches the list it opens on. The
  // one place a waiting request is counted on the phone; the agents' rows
  // only label theirs.
  const waiting = useApp((s) =>
    s.overview
      ? feedItems(
          s.overview.agents,
          s.chats,
          s.teamSetup,
          canCall('agents.import.review', s.welcome)
        ).length
      : 0
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
      {/* First: Catch up, every card waiting on you across all agents, with the one count. */}
      <NativeTabs.Trigger name="catch-up">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'tray', selected: 'tray.fill' }}
          md="inbox"
        />
        <NativeTabs.Trigger.Label>Catch up</NativeTabs.Trigger.Label>
        {live && waiting > 0 && (
          <NativeTabs.Trigger.Badge>{String(waiting)}</NativeTabs.Trigger.Badge>
        )}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
          md="forum"
        />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
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
