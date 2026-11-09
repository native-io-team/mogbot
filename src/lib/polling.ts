/**
 * Exponential Backoff Polling Utilities
 *
 * Provides polling with exponential backoff for more efficient resource usage
 * and better handling of failures.
 */

import { logger } from './logger';
import { asCommandError, formatCommandError } from './errors';

export interface PollingOptions {
  /** Starting interval in milliseconds */
  initialInterval: number;
  /** Maximum interval in milliseconds */
  maxInterval: number;
  /** Backoff multiplier (default 2) */
  multiplier?: number;
  /** Optional max retry count before stopping */
  maxRetries?: number;
  /** Reset interval on success (default true) */
  resetOnSuccess?: boolean;
  /** Add randomness to prevent thundering herd (default false) */
  jitter?: boolean;
  /** Name for logging purposes */
  name?: string;
}

export interface PollingResult<T> {
  data: T | null;
  error: Error | null;
  attempt: number;
  nextInterval: number;
}

/**
 * Exponential backoff poller class
 */
export class ExponentialPoller<T> {
  private interval: number;
  private attempt = 0;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private isPaused = false;
  private inFlight = false;
  /** When the next poll is due (Date.now() ms), for resuming on time. */
  private dueAt = 0;
  private options: Required<PollingOptions>;

  constructor(
    private fetcher: () => Promise<T>,
    private onResult: (result: PollingResult<T>) => void,
    options: PollingOptions
  ) {
    this.options = {
      multiplier: 2,
      resetOnSuccess: true,
      jitter: false,
      name: 'poller',
      maxRetries: Infinity,
      ...options,
    };
    this.interval = options.initialInterval;
  }

  /**
   * Start polling
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.debug(`${this.options.name}: Starting polling`, {
      interval: this.interval,
    });
    void this.poll();
  }

  /**
   * Stop polling
   */
  /**
   * Hold the next poll (the window is hidden: nothing it fetches can be
   * seen). A poll already running finishes; nothing is scheduled after it.
   */
  pause() {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Carry on after `pause`, on the original cadence: a poll that came due
   * while paused runs now, otherwise the next one waits out what is left of
   * its interval (an hourly check doesn't run every time the window shows).
   */
  resume() {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
    if (this.inFlight || this.timeoutId) return;
    this.schedule(Math.max(0, this.dueAt - Date.now()));
  }

  private schedule(delay: number) {
    this.dueAt = Date.now() + delay;
    if (delay <= 0) {
      void this.poll();
      return;
    }
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      void this.poll();
    }, delay);
  }

  stop() {
    this.isRunning = false;
    this.isPaused = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    logger.debug(`${this.options.name}: Stopped polling`);
  }

  /**
   * Reset interval to initial value
   */
  reset() {
    this.interval = this.options.initialInterval;
    this.attempt = 0;
    logger.debug(`${this.options.name}: Reset interval`, {
      interval: this.interval,
    });
  }

  /**
   * Get current state
   */
  getState() {
    return {
      isRunning: this.isRunning,
      interval: this.interval,
      attempt: this.attempt,
    };
  }

  private async poll() {
    if (!this.isRunning || this.isPaused) return;

    this.attempt++;

    this.inFlight = true;
    try {
      const data = await this.fetcher();

      // Success - optionally reset interval
      if (this.options.resetOnSuccess) {
        this.interval = this.options.initialInterval;
      }

      this.onResult({
        data,
        error: null,
        attempt: this.attempt,
        nextInterval: this.interval,
      });
    } catch (error) {
      // Failure - apply exponential backoff
      const prevInterval = this.interval;
      this.interval = Math.min(this.interval * this.options.multiplier, this.options.maxInterval);

      logger.debug(`${this.options.name}: Backing off`, {
        attempt: this.attempt,
        prevInterval,
        newInterval: this.interval,
        error: formatCommandError(asCommandError(error)),
      });

      this.onResult({
        data: null,
        // Consumers get an Error, but its message has to be the real reason.
        // A Tauri rejection is a plain tagged object, so `String(error)` gave
        // every failed poll the message "[object Object]" (issue #909).
        error:
          error instanceof Error ? error : new Error(formatCommandError(asCommandError(error))),
        attempt: this.attempt,
        nextInterval: this.interval,
      });

      // Check max retries
      if (this.attempt >= this.options.maxRetries) {
        logger.warn(`${this.options.name}: Max retries reached, stopping`, {
          maxRetries: this.options.maxRetries,
        });
        this.inFlight = false;
        this.stop();
        return;
      }
    }
    this.inFlight = false;
    if (!this.isRunning) return;

    // Schedule next poll with optional jitter
    let delay = this.interval;
    if (this.options.jitter) {
      // Add ±25% jitter
      delay = delay * (0.75 + Math.random() * 0.5);
    }

    if (this.isPaused) {
      // Held: `resume` picks it up when it falls due.
      this.dueAt = Date.now() + delay;
      return;
    }
    this.dueAt = Date.now() + delay;
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      void this.poll();
    }, delay);
  }
}

/**
 * Create a one-time retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    multiplier?: number;
  } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelay = 1000, maxDelay = 30000, multiplier = 2 } = options;

  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      logger.debug('Retry with backoff', {
        attempt,
        delay,
        error: formatCommandError(asCommandError(error)),
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * multiplier, maxDelay);
    }
  }

  // This should never be reached
  throw new Error('Retry failed');
}
