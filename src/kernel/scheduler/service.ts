import type { RecurringResearchTickResult } from '../kernel';

export interface RecurringResearchSchedulerKernel {
  recoverInterruptedTasks(): Promise<unknown>;
  runRecurringResearchTick(now?: string): Promise<RecurringResearchTickResult>;
  abortRecurringResearchRuns(): Promise<void>;
}

export interface RecurringResearchSchedulerOptions {
  enabled: boolean;
  tickIntervalMs: number;
  shutdownTimeoutMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface RecurringResearchSchedulerStatus {
  enabled: boolean;
  starting: boolean;
  running: boolean;
  tickInProgress: boolean;
  tickIntervalMs: number;
  lastTickAt?: string;
  lastOutcome?: RecurringResearchTickResult['outcome'];
  lastError?: string;
}

/**
 * Drives one non-overlapping scheduler tick at a time. Durable claims and
 * replay protection remain kernel responsibilities; this loop is only a clock.
 */
export const createRecurringResearchScheduler = (
  kernel: RecurringResearchSchedulerKernel,
  options: RecurringResearchSchedulerOptions,
) => {
  const now = options.now ?? (() => new Date());
  const shutdownTimeoutMs = Math.max(100, Math.min(options.shutdownTimeoutMs ?? 10_000, 60_000));
  let running = false;
  let starting: Promise<void> | undefined;
  let lifecycleGeneration = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<RecurringResearchTickResult> | undefined;
  let lastTickAt: string | undefined;
  let lastOutcome: RecurringResearchTickResult['outcome'] | undefined;
  let lastError: string | undefined;

  const status = (): RecurringResearchSchedulerStatus => ({
    enabled: options.enabled,
    starting: Boolean(starting),
    running,
    tickInProgress: Boolean(inFlight),
    tickIntervalMs: options.tickIntervalMs,
    lastTickAt,
    lastOutcome,
    lastError,
  });

  const tick = (): Promise<RecurringResearchTickResult> => {
    if (!options.enabled || !running) {
      return Promise.resolve({ outcome: 'stopped', reason: 'Scheduler clock is stopped.' });
    }
    if (inFlight) return inFlight;
    const tickAt = now().toISOString();
    lastTickAt = tickAt;
    let tracked!: Promise<RecurringResearchTickResult>;
    tracked = kernel.runRecurringResearchTick(tickAt)
      .then((result) => {
        if (inFlight === tracked) {
          lastOutcome = result.outcome;
          lastError = undefined;
        }
        return result;
      })
      .catch((error) => {
        if (inFlight === tracked) {
          lastError = error instanceof Error ? error.message : 'Recurring research scheduler tick failed.';
          options.onError?.(error);
        }
        throw error;
      })
      .finally(() => {
        if (inFlight === tracked) inFlight = undefined;
      });
    inFlight = tracked;
    return tracked;
  };

  const scheduleNext = (generation: number) => {
    if (!running || !options.enabled || generation !== lifecycleGeneration) return;
    timer = setTimeout(() => {
      void tick().catch(() => undefined).finally(() => scheduleNext(generation));
    }, options.tickIntervalMs);
    timer.unref?.();
  };

  const start = (): Promise<void> => {
    if (running) return Promise.resolve();
    if (starting) return starting;
    const generation = ++lifecycleGeneration;
    const pending = (async () => {
      await kernel.recoverInterruptedTasks();
      if (generation !== lifecycleGeneration) return;
      running = true;
      if (!options.enabled) return;
      timer = setTimeout(() => {
        void tick().catch(() => undefined).finally(() => scheduleNext(generation));
      }, 0);
      timer.unref?.();
    })();
    const tracked = pending.finally(() => {
      if (starting === tracked) starting = undefined;
    });
    starting = tracked;
    return tracked;
  };

  const stop = async (): Promise<void> => {
    if (!running && !starting && !timer && !inFlight) return;
    lifecycleGeneration += 1;
    running = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    await kernel.abortRecurringResearchRuns();
    await starting?.catch(() => undefined);
    const active = inFlight;
    if (active) {
      let timeout: NodeJS.Timeout | undefined;
      let timedOut = false;
      await Promise.race([
        active.catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, shutdownTimeoutMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (timedOut && inFlight === active) {
        inFlight = undefined;
        lastError = `Scheduler shutdown timed out after ${shutdownTimeoutMs} ms.`;
      }
    }
  };

  return { start, stop, tick, status };
};
