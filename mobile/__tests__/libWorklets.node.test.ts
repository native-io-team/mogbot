/**
 * The other worklets the UI thread runs every frame (the dictation waveform's
 * frame clock and bars, the typing dots), as the UI runtime runs them (see
 * ./uiRuntime): rebuilt from their code string, each must give the JS-thread
 * answer, and close over nothing that isn't a worklet or a plain value. An
 * uncaught throw there ends the app, as a pinch did on 6 Nov (zoom.ts).
 */

import * as typingDots from '../src/lib/typingDots';
import * as typingKey from '../src/lib/typingKey';
import * as waveform from '../src/lib/waveform';
import { isWorklet, onUiRuntime, type Worklet } from './uiRuntime';

/** Every way the components call them, edges included. */
const calls: Record<string, unknown[][]> = {
  // waveform.ts
  easeLevel: [
    [0, 1, 16, 35, 140],
    [1, 0, 16, 35, 140],
    [0.5, 0.5, 0, 260, 260],
    [0, 1, 999, 35, 140],
    [0, 1, -5, 35, 140],
  ],
  barHeight: [
    [0, 3, 24],
    [0.5, 3, 24],
    [2, 3, 24],
    [-1, 3, 24],
  ],
  barOpacity: [
    [0, 12],
    [6, 12],
    [20, 12],
    [5, 0],
  ],
  pushLevel: [
    [[0, 0, 0], 0.7],
    [[], 1],
  ],
  // typingDots.ts
  dotPhase: [
    [0, 0],
    [0.1, 2],
    [1.5, 1],
  ],
  dotLevel: [[0], [0.25], [0.6]],
  dotOpacity: [[0], [1], [0.5]],
  // typingKey.ts
  keyDepth: [[0], [0.02], [0.04], [0.1], [0.15], [0.3], [0.38], [0.9], [1], [1.5], [-0.25]],
  keyDrop: [[0], [0.5], [1], [-0.15], [2]],
};

const modules: Record<string, Record<string, unknown>> = { waveform, typingDots, typingKey };
const worklets = Object.entries(modules).flatMap(([mod, exports]) =>
  Object.entries(exports)
    .filter((entry): entry is [string, Worklet] => isWorklet(entry[1]))
    .map(([name, fn]) => [`${mod}.${name}`, name, fn] as const)
);
const call = (fn: Worklet, args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);

describe('lib worklets on the UI runtime', () => {
  it('are found, and all exercised here', () => {
    expect(worklets.length).toBeGreaterThanOrEqual(9);
    for (const [label, name] of worklets) {
      expect({ label, covered: name in calls }).toEqual({ label, covered: true });
    }
  });

  it.each(worklets)('%s gives the JS-thread answer', (label, name, fn) => {
    const ui = onUiRuntime(fn);
    for (const args of calls[name] ?? []) {
      expect({ label, args, out: call(ui, args) }).toEqual({ label, args, out: call(fn, args) });
    }
  });

  it.each(worklets)('%s closes over no plain JS function', (label, _name, fn) => {
    // On the phone, calling a non-worklet function from the UI thread throws.
    const plain = (fn.__closure ?? []).filter((v) => typeof v === 'function' && !isWorklet(v));
    expect({ label, plain: plain.length }).toEqual({ label, plain: 0 });
  });
});
