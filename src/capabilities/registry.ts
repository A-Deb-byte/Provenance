import { WorkerRegistration } from './types';
import { isWorkerRegistration } from './validators';

export interface WorkerAvailabilityReport {
  available: string[];
  configured: string[];
  unavailable: Array<{ id: string; reason: string }>;
}

export interface WorkerRegistry {
  get(workerId: string): WorkerRegistration | undefined;
  list(): WorkerRegistration[];
  report(): WorkerAvailabilityReport;
}

const cloneRegistration = (worker: WorkerRegistration): WorkerRegistration => ({
  ...worker,
  supportedActions: [...worker.supportedActions],
  configuredScopes: worker.configuredScopes.map((scope) => {
    if (scope.family === 'browser') {
      return { ...scope, operations: [...scope.operations], origins: [...scope.origins], downloadRoots: [...scope.downloadRoots] };
    }
    if (scope.family === 'desktop') return { ...scope, operations: [...scope.operations] };
    return { ...scope, operations: [...scope.operations], resourceRoots: [...scope.resourceRoots] };
  }),
});

export const createWorkerRegistry = (registrations: WorkerRegistration[]): WorkerRegistry => {
  const workers = new Map<string, WorkerRegistration>();
  for (const registration of registrations) {
    if (!isWorkerRegistration(registration as unknown)) {
      const suppliedId = (registration as unknown as { id?: string }).id;
      throw new Error(`Invalid worker registration: ${suppliedId || 'unknown'}.`);
    }
    if (workers.has(registration.id)) throw new Error(`Duplicate worker id: ${registration.id}.`);
    workers.set(registration.id, cloneRegistration(registration));
  }
  const sorted = (): WorkerRegistration[] => [...workers.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(cloneRegistration);

  return {
    get: (workerId) => {
      const worker = workers.get(workerId);
      return worker ? cloneRegistration(worker) : undefined;
    },
    list: sorted,
    report: () => {
      const report: WorkerAvailabilityReport = { available: [], configured: [], unavailable: [] };
      for (const worker of sorted()) {
        if (worker.availability === 'available') report.available.push(worker.id);
        else if (worker.availability === 'configured') report.configured.push(worker.id);
        else report.unavailable.push({ id: worker.id, reason: worker.unavailableReason ?? 'Unavailable.' });
      }
      return report;
    },
  };
};
