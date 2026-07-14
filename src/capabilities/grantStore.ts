import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stableSha256 } from './hash';
import type { CapabilityGrant } from './types';
import { isCapabilityGrant } from './validators';

export interface CapabilityGrantStore {
  create(grant: CapabilityGrant): Promise<void>;
  get(id: string): Promise<CapabilityGrant | undefined>;
  list(): Promise<CapabilityGrant[]>;
  transitionActive(
    id: string,
    expectedIntentHash: string,
    next: CapabilityGrant,
  ): Promise<boolean>;
}

const cloneGrant = (grant: CapabilityGrant): CapabilityGrant => structuredClone(grant);

const validateTransition = (current: CapabilityGrant, next: CapabilityGrant): boolean => (
  current.status === 'active' &&
  next.status !== 'active' &&
  next.id === current.id &&
  next.intentId === current.intentId &&
  next.intentHash === current.intentHash &&
  next.workerId === current.workerId &&
  next.riskLevel === current.riskLevel &&
  next.issuedBy === current.issuedBy &&
  next.approvalId === current.approvalId &&
  stableSha256(next.scope) === stableSha256(current.scope) &&
  next.issuedAt === current.issuedAt &&
  next.expiresAt === current.expiresAt &&
  next.maxOps === current.maxOps &&
  isCapabilityGrant(next)
);

export const createMemoryCapabilityGrantStore = (
  initial: readonly CapabilityGrant[] = [],
): CapabilityGrantStore => {
  const grants = new Map<string, CapabilityGrant>();
  for (const grant of initial) {
    if (!isCapabilityGrant(grant)) throw new Error('Cannot load an invalid capability grant.');
    if (grants.has(grant.id)) throw new Error(`Duplicate capability grant id: ${grant.id}.`);
    grants.set(grant.id, cloneGrant(grant));
  }

  return {
    create: async (grant) => {
      if (!isCapabilityGrant(grant)) throw new Error('Cannot persist an invalid capability grant.');
      if (grants.has(grant.id)) throw new Error('Capability grant already exists.');
      grants.set(grant.id, cloneGrant(grant));
    },
    get: async (id) => {
      const grant = grants.get(id);
      return grant ? cloneGrant(grant) : undefined;
    },
    list: async () => [...grants.values()].map(cloneGrant),
    transitionActive: async (id, expectedIntentHash, next) => {
      const current = grants.get(id);
      if (!current || current.intentHash !== expectedIntentHash || !validateTransition(current, next)) return false;
      grants.set(id, cloneGrant(next));
      return true;
    },
  };
};

const loadGrantFile = async (filePath: string): Promise<CapabilityGrant[]> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isCapabilityGrant)) {
      throw new Error('Persisted capability grant file is invalid.');
    }
    const ids = new Set(parsed.map((grant) => grant.id));
    if (ids.size !== parsed.length) throw new Error('Persisted capability grant file contains duplicate ids.');
    return parsed.map(cloneGrant);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

/**
 * File-backed grant store with serialized compare-and-set transitions. A grant
 * is moved out of `active` before any dispatch authorization can be minted.
 */
export const createFileCapabilityGrantStore = async (
  filePath: string,
): Promise<CapabilityGrantStore> => {
  const resolved = path.resolve(filePath);
  const grants = new Map((await loadGrantFile(resolved)).map((grant) => [grant.id, grant]));
  let mutationQueue: Promise<void> = Promise.resolve();

  const persist = async (): Promise<void> => {
    await mkdir(path.dirname(resolved), { recursive: true });
    const temp = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify([...grants.values()], null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, resolved);
  };

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    create: (grant) => mutate(async () => {
      if (!isCapabilityGrant(grant)) throw new Error('Cannot persist an invalid capability grant.');
      if (grants.has(grant.id)) throw new Error('Capability grant already exists.');
      grants.set(grant.id, cloneGrant(grant));
      try {
        await persist();
      } catch (error) {
        grants.delete(grant.id);
        throw error;
      }
    }),
    get: async (id) => {
      await mutationQueue;
      const grant = grants.get(id);
      return grant ? cloneGrant(grant) : undefined;
    },
    list: async () => {
      await mutationQueue;
      return [...grants.values()].map(cloneGrant);
    },
    transitionActive: (id, expectedIntentHash, next) => mutate(async () => {
      const current = grants.get(id);
      if (!current || current.intentHash !== expectedIntentHash || !validateTransition(current, next)) return false;
      grants.set(id, cloneGrant(next));
      try {
        await persist();
        return true;
      } catch (error) {
        grants.set(id, current);
        throw error;
      }
    }),
  };
};
