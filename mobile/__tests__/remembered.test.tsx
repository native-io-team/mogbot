/**
 * What a sheet last read from the Mac: drawn at once when it opens again,
 * kept per paired Mac, bounded, and gone when the Mac is forgotten.
 */

import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { forgetRemembered, recall, remember, useRemembered } from '../src/lib/remembered';
import { setApp } from '../src/lib/store';

const pair = (serverId: string) => setApp({ credentials: { serverId } as never });

beforeEach(() => {
  forgetRemembered();
  pair('srv_a');
});

it('recalls the last answer for a key, and nothing for one never read', () => {
  expect(recall('memory:site')).toBeNull();
  remember('memory:site', ['Prefers short replies']);
  expect(recall('memory:site')).toEqual(['Prefers short replies']);
  remember('memory:site', null);
  expect(recall('memory:site')).toBeNull();
});

it('lets the oldest go past its bound', () => {
  for (let i = 0; i < 200; i++) remember(`k${i}`, i);
  expect(recall('k0')).toBeNull();
  expect(recall('k199')).toBe(199);
});

it('forgets everything', () => {
  remember('reach:site', 1);
  forgetRemembered();
  expect(recall('reach:site')).toBeNull();
});

function Probe({ k, onSet }: { k: string; onSet?: (set: (v: string) => void) => void }) {
  const [value, set] = useRemembered<string>(k);
  onSet?.(set);
  return <Text>{value ?? 'none'}</Text>;
}

it('starts a sheet from its last read, and keeps each new one', async () => {
  remember('srv_a:files:site', 'last time');
  remember('srv_b:files:site', 'another Mac');
  let set: ((v: string) => void) | undefined;
  const view = await render(<Probe k="files:site" onSet={(s) => (set = s)} />);
  // Drawn at once, before any read comes back.
  expect(view.getByText('last time')).toBeTruthy();
  await act(async () => set?.('just read'));
  expect(view.getByText('just read')).toBeTruthy();
  expect(recall('srv_a:files:site')).toBe('just read');
  // Another agent's sheet starts from that agent's own answer.
  await view.rerender(<Probe k="files:fin" />);
  expect(view.getByText('none')).toBeTruthy();
  // Paired to another Mac, the same sheet draws that Mac's, never this one's.
  await act(async () => pair('srv_b'));
  await view.rerender(<Probe k="files:site" />);
  expect(view.getByText('another Mac')).toBeTruthy();
});
