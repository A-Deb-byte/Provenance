import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KernelState } from './types';

const statePath = (runtimeDir: string) => path.join(runtimeDir, 'state.json');
const recoveryStatePath = (runtimeDir: string) => path.join(runtimeDir, 'state.authenticated.json');
const pendingStatePath = (runtimeDir: string) => path.join(runtimeDir, 'state.pending.json');

export interface PendingKernelSnapshot {
  schemaVersion: 1;
  baseEventHash: string | null;
  stateHash: string;
  state: KernelState;
}

export const createEmptyKernelState = (): KernelState => ({
  goals: [],
  tasks: [],
  approvals: [],
  memories: [],
  skillPackages: [],
  skillEvaluations: [],
  skillActivations: [],
  automations: [],
  releaseProposals: [],
  benchmarkRuns: [],
  controls: { stopAll: false },
  lastEventHash: null,
});

const normalizeKernelState = (parsed: Partial<KernelState>): KernelState => ({
  goals: Array.isArray(parsed.goals) ? parsed.goals : [],
  tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
  approvals: Array.isArray(parsed.approvals) ? parsed.approvals : [],
  memories: Array.isArray(parsed.memories) ? parsed.memories : [],
  skillPackages: Array.isArray(parsed.skillPackages) ? parsed.skillPackages : [],
  skillEvaluations: Array.isArray(parsed.skillEvaluations) ? parsed.skillEvaluations : [],
  skillActivations: Array.isArray(parsed.skillActivations) ? parsed.skillActivations : [],
  automations: Array.isArray(parsed.automations) ? parsed.automations : [],
  releaseProposals: Array.isArray(parsed.releaseProposals) ? parsed.releaseProposals : [],
  benchmarkRuns: Array.isArray(parsed.benchmarkRuns) ? parsed.benchmarkRuns : [],
  controls: parsed.controls && typeof parsed.controls === 'object' && !Array.isArray(parsed.controls)
    ? {
      stopAll: parsed.controls.stopAll === true,
      stopAllReason: typeof parsed.controls.stopAllReason === 'string' ? parsed.controls.stopAllReason : undefined,
      updatedAt: typeof parsed.controls.updatedAt === 'string' ? parsed.controls.updatedAt : undefined,
    }
    : { stopAll: false },
  lastEventHash: typeof parsed.lastEventHash === 'string' ? parsed.lastEventHash : null,
});

const readStateFile = async (file: string): Promise<KernelState | null> => {
  try {
    const raw = await readFile(file, 'utf8');
    return normalizeKernelState(JSON.parse(raw) as Partial<KernelState>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const writeJsonAtomically = async (destination: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const hashKernelStateContent = (state: KernelState): string => {
  const { lastEventHash: _ledgerHead, ...content } = state;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(content)), 'utf8')
    .digest('hex');
};

export const readKernelState = async (runtimeDir: string): Promise<KernelState> => {
  return await readStateFile(statePath(runtimeDir)) ?? createEmptyKernelState();
};

export const writeKernelState = async (runtimeDir: string, state: KernelState): Promise<void> => {
  await writeJsonAtomically(statePath(runtimeDir), state);
};

export const readKernelRecoveryState = async (runtimeDir: string): Promise<KernelState | null> => {
  return readStateFile(recoveryStatePath(runtimeDir));
};

export const writeKernelRecoveryState = async (runtimeDir: string, state: KernelState): Promise<void> => {
  await writeJsonAtomically(recoveryStatePath(runtimeDir), state);
};

export const readPendingKernelSnapshot = async (runtimeDir: string): Promise<PendingKernelSnapshot | null> => {
  try {
    const raw = await readFile(pendingStatePath(runtimeDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PendingKernelSnapshot>;
    if (
      parsed.schemaVersion !== 1 ||
      (parsed.baseEventHash !== null && typeof parsed.baseEventHash !== 'string') ||
      typeof parsed.stateHash !== 'string' ||
      !parsed.state ||
      typeof parsed.state !== 'object'
    ) {
      throw new Error('Pending kernel snapshot is malformed.');
    }
    return {
      schemaVersion: 1,
      baseEventHash: parsed.baseEventHash,
      stateHash: parsed.stateHash,
      state: normalizeKernelState(parsed.state),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export const writePendingKernelSnapshot = async (
  runtimeDir: string,
  snapshot: PendingKernelSnapshot,
): Promise<void> => {
  await writeJsonAtomically(pendingStatePath(runtimeDir), snapshot);
};

export const clearPendingKernelSnapshot = async (runtimeDir: string): Promise<void> => {
  await rm(pendingStatePath(runtimeDir), { force: true });
};
