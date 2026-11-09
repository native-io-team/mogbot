import type { AgentDraft, Approval, RoutineStep } from '@shipstudio/companion-protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DraftReview } from '../src/components/draftReview';
import { GateBody } from '../src/components/gateBody';
import { StepsEditor } from '../src/components/stepsEditor';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const preset: Record<string, unknown> = {};
  preset.duration = () => preset;
  preset.delay = () => preset;
  return {
    __esModule: true,
    default: { View },
    FadeIn: preset,
    FadeOut: preset,
    LinearTransition: preset,
  };
});
jest.mock('expo-haptics', () => ({}));
// The loops ask whether their screen is showing (lib/moving.ts).
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

describe('steps on the phone’s routine sheet', () => {
  it('“Then…” adds a step that waits for your OK, and ✕ removes it', async () => {
    let steps: RoutineStep[] = [];
    const onChange = (s: RoutineStep[]) => {
      steps = s;
    };
    const view = await render(<StepsEditor steps={steps} onChange={onChange} />);
    await fireEvent.press(screen.getByText('Then…'));
    expect(steps).toEqual([{ text: '', askFirst: true }]);
    await view.rerender(<StepsEditor steps={steps} onChange={onChange} />);
    await fireEvent.changeText(screen.getByLabelText('Step 2'), 'Post it\nto #team');
    expect(steps[0].text).toBe('Post it to #team');
    await view.rerender(<StepsEditor steps={steps} onChange={onChange} />);
    await fireEvent(screen.getByLabelText('Step 2: wait for your OK first'), 'valueChange', false);
    expect(steps[0].askFirst).toBe(false);
    await view.rerender(<StepsEditor steps={steps} onChange={onChange} />);
    await fireEvent.press(screen.getByLabelText('Remove step 2'));
    expect(steps).toEqual([]);
  });

  it('stops offering more steps at five in all', async () => {
    const four = [1, 2, 3, 4].map((n) => ({ text: `s${n}` }));
    await render(<StepsEditor steps={four} onChange={() => undefined} />);
    expect(screen.queryByText('Add a step')).toBeNull();
  });
});

describe('the drafted agent, reviewed on the phone', () => {
  const draft: AgentDraft = {
    name: 'Morning Brief',
    role: 'Five lines every weekday',
    color: 'teal',
    instructions: 'You read the newsletters.',
    routines: [
      {
        when: 'every friday at 16:00',
        note: 'Draft the weekly recap',
        then: [{ text: 'Post it to #team', askFirst: true }],
        readsAs: 'every friday at 16:00',
      },
      { when: 'whenever', note: 'Tidy', problem: 'Can’t be scheduled as written.' },
    ],
    apps: ['Slack'],
  };

  it('shows each routine as read, its steps, why one can’t be set, and the apps it will ask for', async () => {
    const onKept = jest.fn();
    await render(
      <DraftReview
        draft={draft}
        instructions={draft.instructions}
        onInstructions={() => undefined}
        kept={[true, false]}
        onKept={onKept}
      />
    );
    expect(screen.getByText('Every Friday at 16:00')).toBeTruthy();
    expect(screen.getByText('After your OK: Post it to #team')).toBeTruthy();
    expect(screen.getByText('Can’t be scheduled as written.')).toBeTruthy();
    expect(screen.getByLabelText('Whenever: Tidy').props.disabled).toBe(true);
    expect(screen.getByText(/It asks you to connect it the first time it needs it/)).toBeTruthy();
    await fireEvent(
      screen.getByLabelText('Every Friday at 16:00: Draft the weekly recap'),
      'valueChange',
      false
    );
    expect(onKept).toHaveBeenCalledWith(0, false);
  });
});

describe('“OK to go on?”', () => {
  const approval: Approval = {
    requestId: 'q15',
    title: 'OK to go on?',
    detail: 'Weekly report\n\n- Invoices: 14 sent',
    status: 'pending',
    gate: {
      checkInId: 'c7',
      routine: 'Weekly report',
      done: 1,
      total: 2,
      next: 'Post it to #team on Slack',
      runAt: 1,
    },
  };

  it('says what comes next, word for word, then what the step made', async () => {
    await render(<GateBody approval={approval} />);
    expect(screen.getByText('Next, step 2 of 2')).toBeTruthy();
    expect(screen.getByText('Post it to #team on Slack')).toBeTruthy();
    expect(screen.getByLabelText('What step 1 produced')).toBeTruthy();
  });
});
