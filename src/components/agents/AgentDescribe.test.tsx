import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { ModalProvider } from '../../contexts/ModalContext';
import { AgentEditorModal } from './AgentEditorModal';
import { AgentGateBody, AgentStepsEditor, AgentStepsList } from './AgentRoutineSteps';
import type { AgentDraft, EngineInfo, RoutineStep } from '../../lib/agents';

const store = vi.hoisted(() => ({ engines: [] as EngineInfo[] }));
vi.mock('../../lib/agentsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/agentsStore')>()),
  subscribeAgents: () => () => undefined,
  useAgentsSelector: <T,>(select: (s: { engines: EngineInfo[] }) => T) => select(store),
}));

const CLAUDE: EngineInfo = {
  id: 'claude',
  label: 'Claude Code',
  installed: true,
  signedIn: true,
  asks: true,
  models: [{ value: 'opus', label: 'Opus' }],
};

const DRAFT: AgentDraft = {
  name: 'Morning Brief',
  role: 'Five lines on my newsletters every weekday',
  color: 'teal',
  instructions: 'You read the newsletters the user follows.',
  routines: [
    {
      when: 'every weekday at 8:00',
      note: 'Read today’s newsletters and draft the brief',
      readsAs: 'every weekday at 08:00',
    },
    {
      when: 'every friday at 16:00',
      note: 'Draft the weekly recap',
      then: [{ text: 'Post it to #team on Slack', askFirst: true }],
      readsAs: 'every friday at 16:00',
    },
    { when: 'whenever', note: 'Tidy up', problem: 'Can’t be scheduled as written: say when.' },
  ],
  apps: ['Gmail', 'Slack'],
};

afterEach(() => clearMocks());

function open() {
  store.engines = [CLAUDE];
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    if (cmd === 'agents_draft') return DRAFT;
    if (cmd === 'agents_create') return { id: 'new' };
    return cmd === 'list_projects' ? [] : null;
  });
  render(
    <ModalProvider>
      <AgentEditorModal isOpen onClose={vi.fn()} onSaved={vi.fn()} takenColors={['white']} />
    </ModalProvider>
  );
  return calls;
}

describe('Describe the agent you want', () => {
  it('drafts every field, then creates with the routines left ticked', async () => {
    const calls = open();
    const box = screen.getByLabelText('Describe the agent you want');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'Brief me on my newsletters every weekday at 8' } });
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Draft it' }));
      return Promise.resolve();
    });
    await waitFor(() => expect(screen.getByLabelText('Agent name')).toHaveValue('Morning Brief'));
    expect(calls.find((c) => c.cmd === 'agents_draft')?.args).toEqual({
      description: 'Brief me on my newsletters every weekday at 8',
    });
    expect(screen.getByDisplayValue(DRAFT.role)).toBeInTheDocument();
    expect(screen.getByDisplayValue(DRAFT.instructions)).toBeInTheDocument();
    // The time as the app read it; the step that waits, in words.
    expect(screen.getByText('Every weekday at 08:00')).toBeInTheDocument();
    expect(screen.getByText('After your OK ·')).toBeInTheDocument();
    // One it couldn't read: said, and it can't be kept.
    expect(screen.getByText(/Can’t be scheduled as written/)).toBeInTheDocument();
    expect(screen.getByLabelText('Keep: Whenever, Tidy up')).toBeDisabled();
    // Apps are what it will ask for, never "connected".
    expect(screen.getByText(/It asks you to connect them the first time/)).toBeInTheDocument();
    expect(screen.queryByText(/connected/i)).toBeNull();
    // Leave the morning brief out.
    fireEvent.click(
      screen.getByLabelText(
        'Keep: Every weekday at 08:00, Read today’s newsletters and draft the brief'
      )
    );
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      return Promise.resolve();
    });
    const input = calls.find((c) => c.cmd === 'agents_create')?.args.input as Record<
      string,
      unknown
    >;
    expect(input.name).toBe('Morning Brief');
    expect(input.color).toBe('teal');
    expect(input.routines).toEqual([
      {
        when: 'every friday at 16:00',
        note: 'Draft the weekly recap',
        then: [{ text: 'Post it to #team on Slack', askFirst: true }],
      },
    ]);
  });

  it('Start over brings the one prompt back and clears what was drafted', async () => {
    open();
    fireEvent.change(screen.getByLabelText('Describe the agent you want'), {
      target: { value: 'Brief me on my newsletters every weekday at 8' },
    });
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Draft it' }));
      return Promise.resolve();
    });
    await waitFor(() => screen.getByText(/Drafted from your description/));
    expect(screen.queryByRole('group', { name: 'Start from' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByLabelText('Describe the agent you want')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent name')).toHaveValue('');
  });

  it('says why a draft failed, and creates nothing', async () => {
    store.engines = [CLAUDE];
    mockIPC((cmd) => {
      if (cmd === 'agents_draft') {
        // Tauri rejects with the CommandError value itself, not an Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject({
          type: 'Other',
          message: 'Claude Code isn’t signed in. Sign in to it first.',
          expected: true,
        });
      }
      return cmd === 'list_projects' ? [] : null;
    });
    render(
      <ModalProvider>
        <AgentEditorModal isOpen onClose={vi.fn()} onSaved={vi.fn()} />
      </ModalProvider>
    );
    fireEvent.change(screen.getByLabelText('Describe the agent you want'), {
      target: { value: 'Something that watches my inbox' },
    });
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Draft it' }));
      return Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/signed in/));
  });
});

describe('routines in steps', () => {
  it('adds a step that asks first, and removes it', () => {
    let steps: RoutineStep[] = [];
    const { rerender } = render(<AgentStepsEditor steps={steps} onChange={(s) => (steps = s)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Then…' }));
    expect(steps).toEqual([{ text: '', askFirst: true }]);
    rerender(<AgentStepsEditor steps={steps} onChange={(s) => (steps = s)} />);
    fireEvent.change(screen.getByLabelText('Step 2'), { target: { value: 'Post it' } });
    expect(steps[0].text).toBe('Post it');
    rerender(<AgentStepsEditor steps={steps} onChange={(s) => (steps = s)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 2' }));
    expect(steps).toEqual([]);
  });

  it('lists a routine’s steps, and nothing for one step', () => {
    const { container, rerender } = render(<AgentStepsList item={{ note: 'Brief me' }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <AgentStepsList
        item={{ note: 'Draft it', then: [{ text: 'Post it to #team', askFirst: true }] }}
      />
    );
    expect(screen.getByRole('list', { name: 'Steps' })).toHaveTextContent(
      '1Draft it2After your OK · Post it to #team'
    );
  });

  it('the card shows what comes next and what the step made, folded when long', () => {
    const gate = {
      checkInId: 'c1',
      routine: 'Weekly report',
      done: 1,
      total: 2,
      next: 'Post it to #team on Slack',
      runAt: 1,
    };
    render(<AgentGateBody gate={gate} produced={'Weekly report\n\n' + 'x'.repeat(900)} />);
    expect(screen.getByText('Next, step 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('Post it to #team on Slack')).toBeInTheDocument();
    expect(screen.getByText('What step 1 made')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });
});
