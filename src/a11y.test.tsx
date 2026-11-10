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
import { StackMeter, UsageKey } from './components/agents/UsageStack';
import type { Agent } from './lib/agents';
import type { StackKey } from '../packages/companion-protocol/src/usageGlance';
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

  it('the usage meter and an account key', async () => {
    const key: StackKey = {
      key: 'claude:a1',
      id: 'a1',
      engine: 'claude',
      name: 'Work',
      position: 1,
      detail: ['Max plan'],
      state: 'in_use',
      stateLabel: 'In use',
      tone: 'calm',
      left: 40,
      limits: [{ key: 'five_hour', label: '5-hour', left: 40, tone: 'calm', resetsIn: 'in 2 h' }],
      spent: ['Riley · 3 turns'],
      changes: [],
      fix: null,
      canUse: false,
      signedIn: true,
      thisMac: false,
      pinnedBy: [],
    } as StackKey;
    await check(
      <div>
        <StackMeter keys={[key]} />
        <UsageKey
          k={key}
          draggable={false}
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
