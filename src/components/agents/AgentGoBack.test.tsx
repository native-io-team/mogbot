import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import {
  ComposerEditing,
  GoBackConfirm,
  GoBackContextMenu,
  GoBackMenu,
  GoBackPicker,
  foldRows,
  openOneFold,
} from './AgentGoBack';
import { REWOUND_END, rewoundIds } from '../../../packages/companion-protocol/src/rewind';

const idle = { agentName: 'Writer', working: false, driven: false };

describe('GoBackMenu', () => {
  it('offers Edit, Fork and Rewind on your message', () => {
    const onPick = vi.fn();
    render(<GoBackMenu state={idle} onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to here' }));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Edit and resend', 'Fork from here', 'Rewind to here']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rewind to here' }));
    expect(onPick).toHaveBeenCalledWith('rewind');
  });

  it('waits for the turn in progress to edit or rewind, never to fork', () => {
    render(<GoBackMenu state={{ ...idle, working: true }} onPick={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to here' }));
    expect(screen.getByRole('menuitem', { name: 'Edit and resend' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Rewind to here' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Fork from here' })).not.toBeDisabled();
    expect(screen.getByText('Writer is working. Wait for it to finish, or Stop it.')).toBeTruthy();
  });
});

describe('GoBackContextMenu', () => {
  it('opens on a right-click of your message with Copy, Remember, then the three ways back', () => {
    const onPick = vi.fn();
    render(
      <GoBackContextMenu state={idle} text="Fix it" onPick={onPick} onRemember={() => {}}>
        <div>Fix it</div>
      </GoBackContextMenu>
    );
    fireEvent.contextMenu(screen.getByText('Fix it'));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(items).toEqual([
      'Copy',
      'Remember this',
      'Edit and resend',
      'Fork from here',
      'Rewind to here',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Fork from here/ }));
    expect(onPick).toHaveBeenCalledWith('fork');
  });
});

describe('GoBackPicker', () => {
  it('lists your recent messages, each with Edit, Fork and Rewind', () => {
    const onPick = vi.fn();
    render(
      <GoBackPicker
        open
        messages={[
          { id: 'b', text: 'Keep three sections', ts: Date.now() },
          { id: 'a', text: 'Plan the launch email', ts: Date.now() - 60_000 },
        ]}
        state={{ ...idle, working: true }}
        onPick={onPick}
        onClose={() => {}}
      />
    );
    const rows = screen.getAllByRole('listitem').map((r) => r.textContent);
    expect(rows[0]).toContain('“Keep three sections”');
    expect(rows[1]).toContain('“Plan the launch email”');
    // Working: going back in place waits, a fork never does.
    expect(
      screen.getByRole('button', { name: 'Rewind to here: “Plan the launch email”' })
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Fork from here: “Plan the launch email”' })
    );
    expect(onPick).toHaveBeenCalledWith('fork', 'a');
  });
});

describe('GoBackConfirm', () => {
  it('says what stays and what isn’t undone, and the copy’s Discard for a bound agent', () => {
    const onConfirm = vi.fn();
    render(
      <GoBackConfirm
        ask={{ action: 'rewind', messageId: 'm2', text: 'Make it about pricing\nthanks' }}
        agentName="Writer"
        project="site"
        busy={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />
    );
    expect(screen.getByText('Rewind to here?')).toBeTruthy();
    const body = screen.getByText(/carries on from just before/).textContent ?? '';
    expect(body).toContain('“Make it about pricing”');
    expect(body).toContain('folded, not deleted');
    expect(body).toContain('aren’t undone');
    expect(body).toContain('Its copy of site keeps its changes too');
    fireEvent.click(screen.getByRole('button', { name: 'Rewind' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('a fork leaves this conversation as it is', () => {
    render(
      <GoBackConfirm
        ask={{ action: 'fork', messageId: 'm2', text: 'Cut the budget' }}
        agentName="Writer"
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    expect(screen.getByText('Fork from here?')).toBeTruthy();
    expect(screen.getByText(/This one stays as it is/)).toBeTruthy();
    expect(screen.queryByText(/Its copy of/)).toBeNull();
  });

  it('shows nothing when nothing is asked', () => {
    const { container } = render(
      <GoBackConfirm
        ask={null}
        agentName="Writer"
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );
    expect(container.textContent).toBe('');
  });
});

describe('ComposerEditing', () => {
  it('says sending goes back, quoting the message, and can be cancelled', () => {
    const onCancel = vi.fn();
    render(<ComposerEditing text="Draft the launch post" onCancel={onCancel} />);
    expect(screen.getByText(/Sending goes back to just before it/).textContent).toContain(
      '“Draft the launch post”'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop editing' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

type Item = { id: string; ids: string[] };

function Rows({ items, rewound }: { items: Item[]; rewound: Map<string, string> }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const rows: (ReactElement | null)[] = items.map((i) => (
    <p key={i.id} data-testid="row">
      {i.id}
    </p>
  ));
  const out = foldRows(
    rows,
    items,
    rewound,
    (i) => i.ids,
    open,
    (id) =>
      setOpen((o) => {
        const n = new Set(o);
        if (!n.delete(id)) n.add(id);
        return n;
      })
  );
  // The row count never changes: the working line is placed by index.
  expect(out).toHaveLength(rows.length);
  return <div>{out}</div>;
}

describe('foldRows', () => {
  const items: Item[] = [
    { id: 'a', ids: ['a'] },
    { id: 'b', ids: ['b'] },
    { id: 'peer', ids: ['c', 'd'] },
    { id: 'note', ids: ['n'] },
  ];
  const rewound = rewoundIds([{ id: 'r1', at: 'b', ts: 1, ids: ['b', 'c', 'd'] }]);

  it('folds what a rewind passed over into one line that opens it', () => {
    render(<Rows items={items} rewound={rewound} />);
    const shown = () => screen.getAllByTestId('row').map((r) => r.textContent);
    expect(shown()).toEqual(['a', 'note']);
    const toggle = screen.getByRole('button', { name: 'Rewound · 3 messages' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(shown()).toEqual(['a', 'b', 'peer', 'note']);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Opened, the run is closed by its own line, right after its last row.
    const end = screen.getByText(REWOUND_END);
    expect(end.previousElementSibling?.textContent).toBe('peer');
    fireEvent.click(toggle);
    expect(screen.queryByText(REWOUND_END)).toBeNull();
  });

  it('keeps one fold open at a time, so the band between its lines is one run', () => {
    expect([...openOneFold(new Set(), 'r1')]).toEqual(['r1']);
    expect([...openOneFold(new Set(['r1']), 'r2')]).toEqual(['r2']);
    expect([...openOneFold(new Set(['r2']), 'r2')]).toEqual([]);
  });

  it('leaves a chat with no rewinds exactly as it was', () => {
    const rows = [<p key="x">x</p>];
    expect(
      foldRows(
        rows,
        [{ id: 'x', ids: ['x'] }],
        new Map(),
        (i) => i.ids,
        new Set(),
        () => {}
      )
    ).toBe(rows);
  });
});
