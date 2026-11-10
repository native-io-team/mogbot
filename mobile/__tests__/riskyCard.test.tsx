/**
 * A request the Mac marked risky (`approval.risk`, desktop `mcp::risk_of`:
 * Bold's floor) reads as dangerous on the phone, as on the desk: the warning
 * icon, and Allow in the danger style. A low-risk one keeps the neutral
 * answer. The phone never works risk out from the words.
 */

import type { AgentMessage, Approval } from '@shipstudio/companion-protocol';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { ARM_MS, ApprovalCard } from '../src/components/ApprovalCard';
import { setApp } from '../src/lib/store';
import { palettes } from '../src/lib/theme';
import { agent } from './helpers';

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
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('../src/lib/haptics', () => ({
  haptic: {
    light: jest.fn(),
    select: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('../src/lib/session', () => ({
  answerApproval: jest.fn(() => Promise.resolve(null)),
  call: jest.fn(),
  describeError: String,
}));

const request = (risk: Approval['risk']): Approval => ({
  requestId: 'req_rm',
  title: 'Delete files',
  detail: 'rm -r ~/Exports/2024',
  status: 'pending',
  tool: 'Bash',
  risk,
});
const message = (approval: Approval): AgentMessage => ({
  id: `m-${approval.risk ?? 'none'}`,
  agentId: 'temp',
  ts: 1,
  kind: 'approval',
  text: '',
  approval,
});

beforeEach(() => {
  jest.useFakeTimers();
  setApp({ link: { kind: 'connected' } as never });
});

const allowInk = async (risk: Approval['risk']) => {
  const a = request(risk);
  await render(
    <ApprovalCard
      message={message(a)}
      approval={a}
      agent={agent({ id: 'temp' })}
      onError={() => {}}
    />
  );
  await act(() => jest.advanceTimersByTime(ARM_MS + 50));
  const style = StyleSheet.flatten(
    (screen.getByText('Allow').props as { style?: StyleProp<TextStyle> }).style
  );
  return style?.color;
};

const danger = [palettes.light.accentErrorLight, palettes.dark.accentErrorLight];

it('a risky request’s Allow is the danger style', async () => {
  expect(danger).toContain(await allowInk('high'));
});

it('a low-risk request keeps the neutral answer', async () => {
  expect(danger).not.toContain(await allowInk('low'));
});

it('an unclassified one keeps the neutral answer (no danger the Mac didn’t say)', async () => {
  expect(danger).not.toContain(await allowInk(undefined));
});
