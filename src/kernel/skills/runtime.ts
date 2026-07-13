import crypto from 'node:crypto';
import {
  PureTransformOperation,
  PureTransformProgram,
} from '../types';

export const HARD_MAX_INPUT_CHARS = 32 * 1024;
export const HARD_MAX_OUTPUT_CHARS = 128 * 1024;
export const HARD_MAX_STEPS = 4;

export const PURE_TRANSFORM_OPERATIONS: readonly PureTransformOperation[] = Object.freeze([
  'trim',
  'collapse_whitespace',
  'lowercase',
  'uppercase',
  'sort_lines',
]);

const supportedOperations = new Set<string>(PURE_TRANSFORM_OPERATIONS);

export interface PureTransformRuntimeLimits {
  maxInputChars?: number;
  maxSteps?: number;
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const resolveLimit = (
  supplied: number | undefined,
  hardLimit: number,
  label: string,
): number => {
  if (supplied === undefined) return hardLimit;
  if (!Number.isInteger(supplied) || supplied < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return Math.min(supplied, hardLimit);
};

const applyOperation = (operation: PureTransformOperation, input: string): string => {
  switch (operation) {
    case 'trim':
      return input.trim();
    case 'collapse_whitespace':
      return input.replace(/\s+/gu, ' ');
    case 'lowercase':
      return input.toLowerCase();
    case 'uppercase':
      return input.toUpperCase();
    case 'sort_lines':
      return input
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .sort(compareText)
        .join('\n');
  }
};

export const runPureTransform = (
  program: PureTransformProgram,
  input: string,
  limits: PureTransformRuntimeLimits = {},
): string => {
  if (program.runtime !== 'pure-transform-v1' || !Array.isArray(program.steps)) {
    throw new Error('Unsupported pure transform runtime.');
  }
  if (typeof input !== 'string') {
    throw new Error('Pure transform input must be text.');
  }

  const maxInputChars = resolveLimit(limits.maxInputChars, HARD_MAX_INPUT_CHARS, 'maxInputChars');
  const maxSteps = resolveLimit(limits.maxSteps, HARD_MAX_STEPS, 'maxSteps');
  if (input.length > maxInputChars) {
    throw new Error(`Pure transform input exceeds the ${maxInputChars} character limit.`);
  }
  if (program.steps.length > maxSteps) {
    throw new Error(`Pure transform step count exceeds the ${maxSteps} step limit.`);
  }

  let output = input;
  for (const step of program.steps) {
    const operation = (step as { operation?: unknown })?.operation;
    if (typeof operation !== 'string' || !supportedOperations.has(operation)) {
      throw new Error(`Unsupported pure transform operation: ${String(operation)}.`);
    }
    output = applyOperation(operation as PureTransformOperation, output);
    if (output.length > HARD_MAX_OUTPUT_CHARS) {
      throw new Error(`Pure transform output exceeds the ${HARD_MAX_OUTPUT_CHARS} character limit.`);
    }
  }
  return output;
};

const canonicalJsonValue = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON does not support non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('Canonical JSON does not support cyclic values.');
    ancestors.add(value);
    const result = `[${value.map((item) => item === undefined ? 'null' : canonicalJsonValue(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('Canonical JSON does not support cyclic values.');
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key], ancestors)}`);
    ancestors.delete(value);
    return `{${fields.join(',')}}`;
  }
  throw new Error(`Canonical JSON does not support ${typeof value} values.`);
};

export const canonicalJson = (value: unknown): string => canonicalJsonValue(value, new Set());

export const stableHash = (value: unknown): string => {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
};
