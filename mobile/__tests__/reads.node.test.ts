/**
 * The phone never piles onto the Mac (lib/reads): the same read on its way
 * twice is one request, reads queue past a few at once, a fresh read is
 * answered from the last one, and any change makes what's kept old.
 */

import { createReads } from '../src/lib/reads';

/** A request that answers when the test says. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it('the same read asked twice while it is on its way is one request', async () => {
  const reads = createReads();
  const d = deferred<string>();
  const request = jest.fn(() => d.promise);
  const a = reads.call('agents.quota', {}, request);
  const b = reads.call('agents.quota', {}, request);
  expect(request).toHaveBeenCalledTimes(1);
  d.resolve('q');
  await expect(a).resolves.toBe('q');
  await expect(b).resolves.toBe('q');
  // Once it has landed, the next one asks again.
  await reads.call('agents.quota', {}, () => Promise.resolve('q2'));
  expect(reads.last('agents.quota', {})).toBe('q2');
});

it('reads with other params, and changes, are never shared', async () => {
  const reads = createReads();
  const request = jest.fn(() => new Promise<never>(() => {}));
  void reads.call('agents.messages', { agentId: 'a' }, request);
  void reads.call('agents.messages', { agentId: 'b' }, request);
  void reads.call('agents.send', { agentId: 'a', text: 'hi', clientId: '1' }, request);
  void reads.call('agents.send', { agentId: 'a', text: 'hi', clientId: '1' }, request);
  expect(request).toHaveBeenCalledTimes(4);
});

it('no more than a few reads are at the Mac at once; changes never wait', async () => {
  const reads = createReads(Date.now, 2);
  const waiting = [deferred<number>(), deferred<number>(), deferred<number>()];
  let at = 0;
  const started: number[] = [];
  const ask = (n: number) =>
    reads.call('agents.messages', { agentId: String(n) }, () => {
      started.push(n);
      return waiting[at++].promise;
    });
  const all = [ask(1), ask(2), ask(3)];
  expect(started).toEqual([1, 2]);
  const change = jest.fn(() => Promise.resolve(null));
  void reads.call('agents.stop', { agentId: '1' }, change);
  expect(change).toHaveBeenCalledTimes(1);
  waiting[0].resolve(1);
  await all[0];
  await Promise.resolve();
  expect(started).toEqual([1, 2, 3]);
  // A read that fails gives its place up too.
  waiting[1].reject(new Error('no'));
  await expect(all[1]).rejects.toThrow('no');
  waiting[2].resolve(3);
  await expect(all[2]).resolves.toBe(3);
});

it('a fresh read is answered from the last one until it is old or something changed', async () => {
  let t = 1_000;
  const reads = createReads(() => t);
  const request = jest.fn(() => Promise.resolve(['quota']));
  await reads.fresh('agents.quota', {}, 20_000, request);
  t += 5_000;
  await reads.fresh('agents.quota', {}, 20_000, request);
  expect(request).toHaveBeenCalledTimes(1);
  // Looking at a chat changes no reading.
  await reads.call('agents.focus', { agentId: 'a' }, () => Promise.resolve(null));
  await reads.fresh('agents.quota', {}, 20_000, request);
  expect(request).toHaveBeenCalledTimes(1);
  // Old: asked again.
  t += 20_000;
  await reads.fresh('agents.quota', {}, 20_000, request);
  expect(request).toHaveBeenCalledTimes(2);
  // A change: asked again, though it was just read; what's kept still shows meanwhile.
  await reads.call('agents.accounts.use', { engine: 'claude', id: 'w1' }, () =>
    Promise.resolve([])
  );
  expect(reads.last('agents.quota', {})).toEqual(['quota']);
  await reads.fresh('agents.quota', {}, 20_000, request);
  expect(request).toHaveBeenCalledTimes(3);
});

it('another Mac keeps nothing of the last one, even an answer that lands after', async () => {
  const reads = createReads();
  const d = deferred<string>();
  const late = reads.call('agents.accounts', {}, () => d.promise);
  reads.forget();
  d.resolve('old Mac');
  await late;
  expect(reads.last('agents.accounts', {})).toBeUndefined();
});
