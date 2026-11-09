/**
 * The Projects side: its sidebar and its project list are separate areas, so
 * one that throws leaves the other (and the way back to Agents) on screen
 * instead of blanking the window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AppViewRouter, type AppViewRouterProps } from './AppViewRouter';

const broken = vi.hoisted(() => ({ sidebar: false, list: false }));

vi.mock('./workspace/HomeSidebar', () => ({
  HomeSidebar: () => {
    if (broken.sidebar) throw new Error('sidebar broke');
    return <nav>sidebar</nav>;
  },
}));
vi.mock('./dashboard/ProjectsView', () => ({
  ProjectsView: () => {
    if (broken.list) throw new Error('list broke');
    return <main>projects</main>;
  },
}));
vi.mock('./agents/AgentsView', () => ({ AgentsView: () => null }));

afterEach(() => {
  cleanup();
  broken.sidebar = false;
  broken.list = false;
  vi.restoreAllMocks();
});

const props = {
  view: 'projects',
  isCompact: false,
  homeSidebarProps: {},
  projectsViewProps: {},
  pendingMonorepoPick: null,
  toasts: [],
  onDismissToast: () => {},
  quitConfirmModal: null,
} as unknown as AppViewRouterProps;

const PART = 'This part couldn’t be shown. Nothing was lost.';

describe('the Projects side', () => {
  it('a broken project list keeps the sidebar', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    broken.list = true;
    render(<AppViewRouter {...props} />);
    expect(await screen.findByText(PART)).toBeTruthy();
    expect(screen.getByText('sidebar')).toBeTruthy();
  });

  it('a broken sidebar keeps the project list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    broken.sidebar = true;
    render(<AppViewRouter {...props} />);
    expect(await screen.findByText('projects')).toBeTruthy();
    expect(screen.getByText(PART)).toBeTruthy();
  });
});
