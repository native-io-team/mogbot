/**
 * A worklet as the UI runtime runs it, not as Jest's JS thread does.
 *
 * On the phone a worklet is rebuilt on the UI runtime from its code string
 * (`__initData.code`), with what it closed over handed in as `this.__closure`
 * (worklets in that closure rebuilt the same way). That copy can fail where
 * the JS-thread function works — e.g. a default parameter naming a module
 * constant (`max = MAX_ZOOM`) is evaluated before the closure is unpacked and
 * throws. On the UI runtime an uncaught throw from a gesture callback aborts
 * the app. Not a full emulation: shared values and other closure values are
 * passed through as they are.
 */

export type Worklet = ((...args: never[]) => unknown) & {
  __initData?: { code: string };
  __closure?: unknown[];
};

export function isWorklet(value: unknown): value is Worklet {
  return typeof value === 'function' && typeof (value as Worklet).__initData?.code === 'string';
}

export function onUiRuntime<F extends Worklet>(fn: F, seen = new Map<Worklet, Worklet>()): F {
  const known = seen.get(fn);
  if (known) return known as F;
  // Indirect eval: global scope, so nothing from the test's module leaks in.
  const rebuilt = (0, eval)(fn.__initData!.code) as (...args: unknown[]) => unknown;
  const self = { __closure: [] as unknown[] };
  const run = ((...args: unknown[]) => rebuilt.apply(self, args)) as unknown as F;
  seen.set(fn, run);
  self.__closure = (fn.__closure ?? []).map((v) => (isWorklet(v) ? onUiRuntime(v, seen) : v));
  return run;
}
