/**
 * Total compute on the phone's Usage sheet: every account at once, from what
 * the Mac really serves (companion/fixtures.rs), each account once.
 */

import { render, screen } from '@testing-library/react-native';
import { ComputeAccount, ComputeSummary } from '../src/components/usage';
import { computeView } from '../src/lib/usageSheet';
import * as real from '../../packages/companion-protocol/src/fixtures.gen';

const served = real.agentsUsagePlan;

describe('total compute, on the phone', () => {
  it('says what there is room on, each kind of limit, and the estimate across accounts', async () => {
    const view = computeView(served, served.now);
    expect(view).not.toBeNull();
    if (!view) return;
    await render(<ComputeSummary view={view} />);
    expect(
      screen.getByText(/^You have room on 2 accounts right now\. Codex · Plus resets /)
    ).toBeTruthy();
    expect(screen.getByText('3 accounts · Claude 2, Codex 1')).toBeTruthy();
    expect(screen.getByText('5-hour')).toBeTruthy();
    expect(screen.getByText('2 of 3 have room')).toBeTruthy();
    expect(
      screen.getByText(/^At this pace you’ll run out of Claude on every account /)
    ).toBeTruthy();
    expect(screen.getByText('Estimate from 11 readings across 2 accounts')).toBeTruthy();
  });

  it('draws an account compactly: name, Next turn, both bars, its pace', async () => {
    const view = computeView(served, served.now);
    const [mac, work, plus] = view?.rows ?? [];
    await render(<ComputeAccount row={mac} />);
    expect(screen.getByText('Claude · This Mac')).toBeTruthy();
    expect(screen.getByText('Next turn')).toBeTruthy();
    expect(screen.getByText('38%')).toBeTruthy();
    expect(screen.getByText(/^5-hour: At this pace you’ll hit the limit/)).toBeTruthy();

    await render(<ComputeAccount row={work} />);
    expect(screen.getByText('Max plan')).toBeTruthy();
    expect(screen.queryByText('Next turn')).toBeNull();

    // Out: a state, never a bar.
    await render(<ComputeAccount row={plus} />);
    expect(screen.getByText(/^Out of usage until /)).toBeTruthy();
    expect(screen.queryByText('100%')).toBeNull();
  });
});
