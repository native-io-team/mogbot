/** Pictures over the relay: a fetch with no answer fails in time, and one can be tried again. */

import { RELAY_IMAGE_GIVE_UP_MS, relayImage, retryRelayImage } from '../src/lib/relayImages';

afterEach(() => jest.useRealTimers());

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('relayImage', () => {
  it('counts a picture with no answer as failed', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn(() => new Promise<string>(() => {}));
    expect(relayImage('k1', fetch)).toBeUndefined();
    jest.advanceTimersByTime(RELAY_IMAGE_GIVE_UP_MS);
    await settle();
    expect(relayImage('k1', fetch)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetches a failed picture again when asked', async () => {
    const fetch = jest.fn().mockRejectedValueOnce(new Error('gone')).mockResolvedValue('file:///p');
    relayImage('k2', fetch);
    await settle();
    expect(relayImage('k2', fetch)).toBeNull();
    retryRelayImage('k2');
    expect(relayImage('k2', fetch)).toBeUndefined();
    await settle();
    expect(relayImage('k2', fetch)).toBe('file:///p');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
