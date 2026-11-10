/**
 * axe-core over the shared primitives and the surfaces built from them, in
 * jsdom: the fast half of the accessibility gate, run with every `pnpm
 * test:run`. Names, roles, states and structure are checked here; contrast
 * and anything else that needs real layout is checked by the harness scan
 * (`pnpm check:a11y`, scripts/harness-a11y.mjs), which reads every scenario
 * in a real Chrome in light and dark.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { Button } from './components/primitives/Button';
import { IconButton } from './components/primitives/IconButton';
import { ModalFrame } from './components/primitives/ModalFrame';
import { SegmentedControl } from './components/primitives/SegmentedControl';
import { Spinner } from './components/primitives/Spinner';
import { Tooltip, TooltipProvider } from './components/primitives/Tooltip';
import { Dropdown, DropdownItem } from './components/primitives/Dropdown';
import { AgentsBoard } from './components/agents/AgentsBoard';
import { AccountDetail, AccountRow, TotalBar } from './components/agents/UsageStack';
import { usageGlance } from './lib/agentsUsage';
import type { Agent } from './lib/agents';
import { CloseIcon, MoreHorizontalIcon } from './components/icons';

afterEach(cleanup);

/** Violations axe finds in what is on the page, as "rule: target" lines. */
async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    // jsdom has no layout: contrast is the harness scan's job.
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

async function check(ui: ReactElement) {
  render(<TooltipProvider>{ui}</TooltipProvider>);
  await act(async () => {});
  expect(await violations()).toEqual([]);
}

const agent = (id: string, name: string, state = 'idle') =>
  ({ id, name, role: '', isMain: false, hidden: false, status: { state } }) as unknown as Agent;

describe('axe: no WCAG A/AA violations', () => {
  it('buttons, icon buttons and tooltips', async () => {
    await check(
      <div>
        <Button onClick={() => {}}>Save</Button>
        <IconButton icon={<CloseIcon size={14} />} aria-label="Close" onClick={() => {}} />
        {/* An icon-only control named only by its tooltip. */}
        <Tooltip content="More options">
          <button type="button">
            <MoreHorizontalIcon size={14} />
          </button>
        </Tooltip>
        <span title="Only a hint">plain words</span>
        <Spinner />
      </div>
    );
  });

  it('a segmented control', async () => {
    await check(
      <SegmentedControl
        aria-label="Theme"
        value="dark"
        onValueChange={() => {}}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />
    );
  });

  it('a modal', async () => {
    await check(
      <ModalFrame isOpen onClose={() => {}} title="Rename">
        <label>
          Name <input defaultValue="Finance" />
        </label>
      </ModalFrame>
    );
  });

  it('an open dropdown', async () => {
    render(
      <TooltipProvider>
        <Dropdown
          search={{ value: '', onChange: () => {}, placeholder: 'Find a conversation' }}
          trigger={(p) => (
            <IconButton {...p} icon={<MoreHorizontalIcon size={14} />} aria-label="More" />
          )}
        >
          <DropdownItem onSelect={() => {}}>Rename</DropdownItem>
          <DropdownItem onSelect={() => {}}>Move up</DropdownItem>
        </Dropdown>
      </TooltipProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await act(async () => {});
    expect(await violations()).toEqual([]);
  });

  it('the board of keys', async () => {
    await check(
      <AgentsBoard
        agents={[agent('f', 'Finance', 'waiting'), agent('r', 'Research')]}
        onOpenAgent={() => {}}
        onNewAgent={() => {}}
      />
    );
  });

  it('the total bar, an account row and an account’s page', async () => {
    const now = Date.now();
    const glance = usageGlance(
      [
        {
          id: 'a1',
          engine: 'claude',
          name: 'Work',
          plan: 'max',
          thisMac: false,
          signedIn: true,
          out: false,
        },
        { id: 'a2', engine: 'claude', name: 'Side', thisMac: false, signedIn: true, out: false },
      ],
      {
        mode: 'normal',
        engines: [],
        accounts: ['a1', 'a2'].map((id, i) => ({
          engine: 'claude' as const,
          id,
          name: id,
          thisMac: false,
          signedIn: true,
          out: false,
          next: i === 0,
          windows: [
            {
              kind: 'seven_day',
              usedPercent: 20 + 40 * i,
              resetsAt: now + 50 * 3_600_000,
              limited: false,
              observedAt: now,
            },
          ],
          learned: [],
          spent: [{ agentId: 'r', name: 'Riley', turns: 3, tokens: 9000 }],
        })),
        local: [],
        spare: [],
        backlog: [],
        agents: [],
        routines: [],
        now,
      },
      { now }
    );
    const key = glance.keys[0];
    await check(
      <div>
        <TotalBar total={glance.total} />
        <TotalBar total={glance.total} size="large" />
        <ul>
          <AccountRow k={key} onOpen={() => {}} onUse={() => {}} />
        </ul>
        <AccountDetail
          k={key}
          actions={{
            onUse: () => {},
            onSignIn: () => {},
            onRename: () => Promise.resolve(true),
            onRemove: () => {},
          }}
        />
      </div>
    );
  });
});
