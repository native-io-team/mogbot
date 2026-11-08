/**
 * Total compute on the phone's Usage sheet: every account at once, from what
 * the Mac really serves (companion/fixtures.rs), each account once.
 */

import { render, screen } from '@testing-library/react-native';
import { ComputeAccount, ComputeQuiet, ComputeSummary } from '../src/components/usage';
import { computeView } from '../src/lib/usageSheet';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

const served = real.agentsUsagePlan;

describe('total compute, on the phone', () => {
  it('answers first in one short line, with the estimate across accounts', async () => {
    const view = computeView(served, served.now);
    expect(view).not.toBeNull();
    if (!view) return;
    await render(<ComputeSummary view={view} />);
    expect(screen.getByText('Room now on 2 of 3 accounts')).toBeTruthy();
    // The cards say who and when; the headline doesn't count or list them again.
    expect(screen.queryByText(/accounts · Claude|have room ·|has room again/)).toBeNull();
    expect(
      screen.getByText(/^At this pace you’ll run out of Claude on every account /)
    ).toBeTruthy();
    expect(screen.getByText('Estimate from 11 readings across 2 accounts')).toBeTruthy();
  });

  it('draws an account as its own card: name, Used next, a row per limit, its pace', async () => {
    const view = computeView(served, served.now);
    const [mac, work] = view?.rows ?? [];
    await render(<ComputeAccount row={mac} />);
    expect(screen.getByText('Claude · This Mac')).toBeTruthy();
    expect(screen.getByText(/Used next/)).toBeTruthy();
    expect(screen.queryByText('Next turn')).toBeNull();
    expect(screen.getByText('5-hour')).toBeTruthy();
    expect(screen.getByText('38%')).toBeTruthy();
    expect(screen.getByText(/^At this pace it runs out /)).toBeTruthy();

    await render(<ComputeAccount row={work} />);
    expect(screen.getByText('Max plan')).toBeTruthy();
    expect(screen.queryByText(/Used next/)).toBeNull();
  });

  it('lists accounts with nothing to draw compactly, never as a bar', async () => {
    const view = computeView(served, served.now);
    await render(<ComputeQuiet rows={view?.quiet ?? []} />);
    expect(screen.getByText('Codex · Plus')).toBeTruthy();
    expect(screen.getByText(/^Out of usage until /)).toBeTruthy();
    expect(screen.queryByText('100%')).toBeNull();
  });
});
