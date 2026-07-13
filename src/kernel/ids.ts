import crypto from 'node:crypto';

export type IdPrefix =
  | 'goal'
  | 'task'
  | 'event'
  | 'approval'
  | 'cap'
  | 'mem'
  | 'skill'
  | 'eval'
  | 'activation'
  | 'automation'
  | 'intent'
  | 'release'
  | 'benchmark'
  | 'obs';

export const createKernelId = (prefix: IdPrefix): string => {
  return `${prefix}_${crypto.randomUUID()}`;
};
