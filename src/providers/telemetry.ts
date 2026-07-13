import { ProviderId, ProviderUsage } from './types';

export interface ProviderTelemetrySample {
  readonly provider: ProviderId;
  readonly succeeded: boolean;
  readonly latencyMs: number;
  readonly usage: ProviderUsage;
  readonly verified?: boolean;
}

export interface ProviderTelemetrySnapshot {
  readonly provider: ProviderId;
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly verifiedSuccesses: number;
  readonly averageLatencyMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface MutableTelemetry {
  calls: number;
  successes: number;
  failures: number;
  verifiedSuccesses: number;
  totalLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const empty = (): MutableTelemetry => ({
  calls: 0,
  successes: 0,
  failures: 0,
  verifiedSuccesses: 0,
  totalLatencyMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const finiteNonNegative = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;

export class ProviderTelemetryStore {
  private readonly records = new Map<ProviderId, MutableTelemetry>();

  record(sample: ProviderTelemetrySample): ProviderTelemetrySnapshot {
    const record = this.records.get(sample.provider) ?? empty();
    record.calls += 1;
    record.successes += sample.succeeded ? 1 : 0;
    record.failures += sample.succeeded ? 0 : 1;
    record.verifiedSuccesses += sample.succeeded && sample.verified ? 1 : 0;
    record.totalLatencyMs += finiteNonNegative(sample.latencyMs);
    record.inputTokens += finiteNonNegative(sample.usage.inputTokens);
    record.outputTokens += finiteNonNegative(sample.usage.outputTokens);
    record.totalTokens += finiteNonNegative(sample.usage.totalTokens);
    this.records.set(sample.provider, record);
    return this.snapshot(sample.provider);
  }

  snapshot(provider: ProviderId): ProviderTelemetrySnapshot {
    const record = this.records.get(provider) ?? empty();
    return Object.freeze({
      provider,
      calls: record.calls,
      successes: record.successes,
      failures: record.failures,
      verifiedSuccesses: record.verifiedSuccesses,
      averageLatencyMs: record.calls ? record.totalLatencyMs / record.calls : null,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
    });
  }

  snapshots(): readonly ProviderTelemetrySnapshot[] {
    return [...this.records.keys()].sort().map((provider) => this.snapshot(provider));
  }
}
