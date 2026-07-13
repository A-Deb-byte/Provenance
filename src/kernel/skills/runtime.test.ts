import { describe, expect, it } from 'vitest';
import { PureTransformProgram } from '../types';
import {
  HARD_MAX_INPUT_CHARS,
  HARD_MAX_STEPS,
  canonicalJson,
  runPureTransform,
  stableHash,
} from './runtime';

describe('pure transform runtime', () => {
  it('applies allowlisted steps with canonical line handling', () => {
    const program: PureTransformProgram = {
      runtime: 'pure-transform-v1',
      steps: [
        { operation: 'trim' },
        { operation: 'lowercase' },
        { operation: 'sort_lines' },
      ],
    };

    expect(runPureTransform(program, '  Zebra\r\nalpha\rBeta  ')).toBe('alpha\nbeta\nzebra');
  });

  it('collapses whitespace to one ASCII space deterministically', () => {
    const program: PureTransformProgram = {
      runtime: 'pure-transform-v1',
      steps: [{ operation: 'collapse_whitespace' }],
    };

    expect(runPureTransform(program, 'alpha\t beta\r\n gamma')).toBe('alpha beta gamma');
  });

  it('enforces both caller limits and immutable hard limits', () => {
    const identity: PureTransformProgram = { runtime: 'pure-transform-v1', steps: [] };
    expect(() => runPureTransform(identity, '1234', { maxInputChars: 3, maxSteps: 1 }))
      .toThrow('input exceeds');
    expect(() => runPureTransform(identity, 'x'.repeat(HARD_MAX_INPUT_CHARS + 1)))
      .toThrow('input exceeds');

    const oversized: PureTransformProgram = {
      runtime: 'pure-transform-v1',
      steps: Array.from({ length: HARD_MAX_STEPS + 1 }, () => ({ operation: 'trim' as const })),
    };
    expect(() => runPureTransform(oversized, 'text')).toThrow('step count exceeds');
  });

  it('rejects unknown runtime instructions without evaluating code', () => {
    const program = {
      runtime: 'pure-transform-v1',
      steps: [{ operation: 'fetch' }],
    } as unknown as PureTransformProgram;

    expect(() => runPureTransform(program, 'text')).toThrow('Unsupported pure transform operation');
  });

  it('canonicalizes object keys and produces stable SHA-256 hashes', () => {
    const first = { z: 1, nested: { b: true, a: ['x', 2] } };
    const second = { nested: { a: ['x', 2], b: true }, z: 1 };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(stableHash(first)).toBe(stableHash(second));
    expect(stableHash(first)).toMatch(/^[a-f0-9]{64}$/);
  });
});
