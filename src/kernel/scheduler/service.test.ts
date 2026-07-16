import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecurringResearchTickResult } from '../kernel';
import { createRecurringResearchScheduler } from './service';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('recurring research scheduler clock', () => {
  it('awaits durable recovery before becoming running', async () => {
    vi.useFakeTimers();
    const recovery = deferred<void>();
    const runRecurringResearchTick = vi.fn(async (): Promise<RecurringResearchTickResult> => ({ outcome: 'idle' }));
    const scheduler = createRecurringResearchScheduler({
      recoverInterruptedTasks: () => recovery.promise,
      runRecurringResearchTick,
      abortRecurringResearchRuns: async () => undefined,
    }, {
      enabled: true,
      tickIntervalMs: 1_000,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    });

    const starting = scheduler.start();
    expect(scheduler.status()).toMatchObject({ running: false, tickInProgress: false });
    expect(runRecurringResearchTick).not.toHaveBeenCalled();
    recovery.resolve(undefined);
    await starting;
    expect(scheduler.status()).toMatchObject({ running: true, tickInProgress: false });

    await vi.advanceTimersByTimeAsync(0);
    expect(runRecurringResearchTick).toHaveBeenCalledOnce();
    expect(runRecurringResearchTick).toHaveBeenCalledWith('2026-07-14T00:00:00.000Z');
    await scheduler.stop();
  });

  it('uses a recursive clock so a slow tick never overlaps another tick', async () => {
    vi.useFakeTimers();
    const first = deferred<RecurringResearchTickResult>();
    const second = deferred<RecurringResearchTickResult>();
    const runRecurringResearchTick = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const scheduler = createRecurringResearchScheduler({
      recoverInterruptedTasks: async () => undefined,
      runRecurringResearchTick,
      abortRecurringResearchRuns: async () => undefined,
    }, {
      enabled: true,
      tickIntervalMs: 1_000,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runRecurringResearchTick).toHaveBeenCalledOnce();
    expect(scheduler.status().tickInProgress).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runRecurringResearchTick).toHaveBeenCalledOnce();

    first.resolve({ outcome: 'idle' });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status()).toMatchObject({ tickInProgress: false, lastOutcome: 'idle' });
    await vi.advanceTimersByTimeAsync(999);
    expect(runRecurringResearchTick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(runRecurringResearchTick).toHaveBeenCalledTimes(2);

    second.resolve({ outcome: 'completed' });
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();
  });

  it('aborts active recurring runs and waits for the in-flight tick during shutdown', async () => {
    vi.useFakeTimers();
    const result = deferred<RecurringResearchTickResult>();
    const abortRecurringResearchRuns = vi.fn(async () => {
      result.resolve({ outcome: 'blocked', reason: 'Scheduler shutdown cancelled the occurrence.' });
    });
    const scheduler = createRecurringResearchScheduler({
      recoverInterruptedTasks: async () => undefined,
      runRecurringResearchTick: () => result.promise,
      abortRecurringResearchRuns,
    }, {
      enabled: true,
      tickIntervalMs: 1_000,
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status().tickInProgress).toBe(true);
    await scheduler.stop();

    expect(abortRecurringResearchRuns).toHaveBeenCalledOnce();
    expect(scheduler.status()).toMatchObject({ running: false, tickInProgress: false, lastOutcome: 'blocked' });
  });

  it('coalesces concurrent starts and honors a stop requested during recovery', async () => {
    vi.useFakeTimers();
    const recovery = deferred<void>();
    const runRecurringResearchTick = vi.fn(async (): Promise<RecurringResearchTickResult> => ({ outcome: 'idle' }));
    const abortRecurringResearchRuns = vi.fn(async () => undefined);
    const scheduler = createRecurringResearchScheduler({
      recoverInterruptedTasks: () => recovery.promise,
      runRecurringResearchTick,
      abortRecurringResearchRuns,
    }, { enabled: true, tickIntervalMs: 1_000 });

    const firstStart = scheduler.start();
    const secondStart = scheduler.start();
    expect(firstStart).toBe(secondStart);
    expect(scheduler.status()).toMatchObject({ starting: true, running: false });
    const stopping = scheduler.stop();
    recovery.resolve(undefined);
    await Promise.all([firstStart, secondStart, stopping]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(abortRecurringResearchRuns).toHaveBeenCalledOnce();
    expect(runRecurringResearchTick).not.toHaveBeenCalled();
    expect(scheduler.status()).toMatchObject({ starting: false, running: false, tickInProgress: false });
  });

  it('bounds shutdown even when an in-flight kernel tick never settles', async () => {
    vi.useFakeTimers();
    const stale = deferred<RecurringResearchTickResult>();
    const current = deferred<RecurringResearchTickResult>();
    const runRecurringResearchTick = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise);
    const scheduler = createRecurringResearchScheduler({
      recoverInterruptedTasks: async () => undefined,
      runRecurringResearchTick,
      abortRecurringResearchRuns: async () => undefined,
    }, {
      enabled: true,
      tickIntervalMs: 1_000,
      shutdownTimeoutMs: 100,
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(100);
    await stopping;

    expect(scheduler.status()).toMatchObject({ running: false, tickInProgress: false });
    expect(scheduler.status().lastError).toMatch(/shutdown timed out after 100 ms/i);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runRecurringResearchTick).toHaveBeenCalledTimes(2);
    expect(scheduler.status()).toMatchObject({ running: true, tickInProgress: true });

    stale.resolve({ outcome: 'completed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status()).toMatchObject({ tickInProgress: true });
    expect(scheduler.status().lastOutcome).not.toBe('completed');

    current.resolve({ outcome: 'idle' });
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status()).toMatchObject({ tickInProgress: false, lastOutcome: 'idle' });
    await scheduler.stop();
  });
});
