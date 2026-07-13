import { describe, expect, it } from 'vitest';
import { assertValidStructuredOutput, validateStructuredOutput } from './schema';

const schema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['answer'],
  additionalProperties: false,
} as const;

describe('structured provider output validation', () => {
  it('accepts the supported JSON Schema subset', () => {
    expect(validateStructuredOutput({ answer: 'yes', confidence: 0.8 }, schema)).toEqual([]);
  });

  it('reports deterministic paths for invalid values', () => {
    expect(validateStructuredOutput({ confidence: 'high', extra: true }, schema)).toEqual([
      '$.answer is required.',
      '$.confidence must be a number.',
      '$.extra is not allowed.',
    ]);
  });

  it('throws a sanitized provider error for invalid structured output', () => {
    expect(() => assertValidStructuredOutput({ answer: 3 }, schema, 'openai')).toThrow(
      'Provider returned structured output that failed local validation.',
    );
  });
});
