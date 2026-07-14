import { describe, expect, it } from 'vitest';
import { parseStructuredText } from './shared';

const format = {
  type: 'json_schema' as const,
  name: 'answer',
  schema: {
    type: 'object' as const,
    properties: { answer: { type: 'string' as const } },
    required: ['answer'],
    additionalProperties: false,
  },
};

describe('structured provider output parsing', () => {
  it('accepts exact, fenced, and prose-wrapped JSON before local schema validation', () => {
    expect(parseStructuredText('{"answer":"ok"}', format, 'openrouter')).toEqual({ answer: 'ok' });
    expect(parseStructuredText('```json\n{"answer":"ok"}\n```', format, 'openrouter')).toEqual({ answer: 'ok' });
    expect(parseStructuredText('Here is the result: {"answer":"ok"}\nDone.', format, 'openrouter')).toEqual({ answer: 'ok' });
  });

  it('still rejects incomplete or non-JSON provider output', () => {
    expect(() => parseStructuredText('{"other":"no"}', format, 'openrouter')).toThrow(/local validation/);
    expect(() => parseStructuredText('not json', format, 'openrouter')).toThrow(/invalid JSON/);
  });
});
