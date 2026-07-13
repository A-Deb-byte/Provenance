import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KernelState } from './types';

const statePath = (runtimeDir: string) => path.join(runtimeDir, 'state.json');

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

export const readKernelState = async (runtimeDir: string): Promise<KernelState> => {
  try {
    const raw = await readFile(statePath(runtimeDir), 'utf8');
    const parsed = JSON.parse(raw) as KernelState;
    return {
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
        ? { stopAll: parsed.controls.stopAll === true, stopAllReason: typeof parsed.controls.stopAllReason === 'string' ? parsed.controls.stopAllReason : undefined, updatedAt: typeof parsed.controls.updatedAt === 'string' ? parsed.controls.updatedAt : undefined }
        : { stopAll: false },
      lastEventHash: typeof parsed.lastEventHash === 'string' ? parsed.lastEventHash : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createEmptyKernelState();
    throw error;
  }
};

export const writeKernelState = async (runtimeDir: string, state: KernelState): Promise<void> => {
  await mkdir(runtimeDir, { recursive: true });
  const destination = statePath(runtimeDir);
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};
