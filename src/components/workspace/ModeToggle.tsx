/**
 * Agents | Projects: the switch between the app's two modes, at the top of
 * the sidebar on every screen that has one (and in the compact headers that
 * stand in for it). Built on the navigation Tabs primitive in its segmented
 * look, since it switches a top-level view rather than filtering in place.
 *
 * While Projects is showing, an amber badge on the Agents segment's corner
 * says an agent wants you; its tooltip says which. The badge is out of flow,
 * so both labels stay centred whether it is there or not.
 *
 * Three layouts: `labels` fills the sidebar's width at the Search field's
 * height; `stacked` is the collapsed rail's, one icon above the other;
 * `icons` is a side-by-side icon pair at the compact top bar's control
 * height (`CompactModeToggle`).
 *
 * @module components/workspace/ModeToggle
 */

import { Tooltip } from '../primitives/Tooltip';
import { AgentsModeIcon, FolderOpenIcon } from '@/components/icons';
import { Tabs, TabsList, TabsTab } from '../primitives/Tabs';
import { useAgentsAttention, type AgentsAttention } from '../../lib/agentsStore';
import { isMac } from '../../lib/setup';
import { kbd } from '../../lib/shortcuts';

export type AppMode = 'projects' | 'agents';

/** The key that flips modes, as shown in tooltips and the palette. */
export const MODE_TOGGLE_SHORTCUT = kbd('mod', 'shift', 'A');

/** "Lead Gen needs your OK · 1 unread", or null when nobody wants you. */
export function describeAgentsAttention({ waiting, unread }: AgentsAttention): string | null {
  const parts: string[] = [];
  if (waiting.length === 1) parts.push(`${waiting[0]} needs your OK`);
  else if (waiting.length === 2) parts.push(`${waiting[0]} and ${waiting[1]} need your OK`);
  else if (waiting.length > 2)
    parts.push(`${waiting[0]} and ${waiting.length - 1} others need your OK`);
  if (unread > 0) parts.push(`${unread} unread`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface ModeToggleProps {
  mode: AppMode;
  onProjects: () => void;
  onAgents: () => void;
  layout?: 'labels' | 'stacked' | 'icons';
  className?: string;
}

export function ModeToggle({
  mode,
  onProjects,
  onAgents,
  layout = 'labels',
  className,
}: ModeToggleProps) {
  const attention = describeAgentsAttention(useAgentsAttention());
  const showDot = attention !== null && mode !== 'agents';
  const iconOnly = layout !== 'labels';
  const tabClass = `mode-toggle__tab${iconOnly ? ' button--icon-only' : ''}`;
  const choose = (next: string) => {
    if (next === mode) return;
    if (next === 'agents') onAgents();
    else onProjects();
  };

  return (
    <Tabs
      mode="navigation"
      // Arrows move focus only: switching the whole app under a keypress
      // that was only meant to look is disorienting. Enter or Space switches.
      activation="manual"
      value={mode}
      onValueChange={choose}
    >
      <TabsList
        aria-label="Mode"
        appearance="segmented"
        className={`mode-toggle mode-toggle--${layout} ${className ?? ''}`}
        // The whole control is the target: a click in its rim or in the
        // hairline between the segments went to the list and did nothing.
        onClick={(event) => {
          const target = event.target as Element;
          if (target.closest('[data-tab-value]')) return;
          const next = nearestSegment(event.currentTarget, event.clientX, event.clientY);
          if (next) choose(next);
        }}
      >
        {/* The app's tooltip, not a native `title`: WKWebView draws native
            tooltips at the window's top-left, under the traffic lights. */}
        <Tooltip content={`${(showDot && attention) || 'Agents'} (${MODE_TOGGLE_SHORTCUT})`}>
          <TabsTab
            value="agents"
            className={tabClass}
            aria-label={showDot ? `Agents, ${attention}` : 'Agents'}
            leftIcon={iconOnly ? <AgentsModeIcon size={12} /> : undefined}
          >
            {iconOnly ? undefined : 'Agents'}
            {showDot && <span className="sidebar-row-dot dot-attention mode-toggle__dot" />}
          </TabsTab>
        </Tooltip>
        <Tooltip content={`Projects (${MODE_TOGGLE_SHORTCUT})`}>
          <TabsTab
            value="projects"
            className={tabClass}
            aria-label="Projects"
            leftIcon={iconOnly ? <FolderOpenIcon size={12} /> : undefined}
          >
            {iconOnly ? undefined : 'Projects'}
          </TabsTab>
        </Tooltip>
      </TabsList>
    </Tabs>
  );
}

/** The segment nearest a point in the control, for clicks between or around them. */
export function nearestSegment(list: Element, x: number, y: number): string | null {
  let best: { value: string; distance: number } | null = null;
  for (const tab of list.querySelectorAll<HTMLElement>('[data-tab-value]')) {
    const r = tab.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const distance = Math.hypot(dx, dy);
    const value = tab.dataset.tabValue;
    if (value && (!best || distance < best.distance)) best = { value, distance };
  }
  return best?.value ?? null;
}

const noop = () => {};

/**
 * Below the compact breakpoint there is no sidebar, so the icon pair sits at
 * the top bar's leading edge instead, clear of the macOS traffic lights.
 * `floating` pins it to the window's top-left for screens with no bar of
 * their own (the dashboard, Workflows, the Inbox).
 */
export function CompactModeToggle({
  mode,
  onProjects = noop,
  onAgents = noop,
  floating = false,
  className,
}: Partial<Pick<ModeToggleProps, 'onProjects' | 'onAgents'>> & {
  mode: AppMode;
  floating?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`mode-toggle-compact${isMac() ? ' mode-toggle-compact--mac' : ''}${
        floating ? ' mode-toggle-compact--floating' : ''
      } ${className ?? ''}`}
    >
      <ModeToggle mode={mode} onProjects={onProjects} onAgents={onAgents} layout="icons" />
    </div>
  );
}
