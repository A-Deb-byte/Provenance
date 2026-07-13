import { ProviderError } from './errors';
import { JsonSchema, ProviderId } from './types';

const matchesType = (value: unknown, type: NonNullable<JsonSchema['type']>): boolean => {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
};

const describeType = (type: NonNullable<JsonSchema['type']>): string => {
  if (type === 'integer') return 'an integer';
  if (type === 'object') return 'an object';
  if (type === 'array') return 'an array';
  return `a ${type}`;
};

const validateAtPath = (value: unknown, schema: JsonSchema, path: string, errors: string[]): void => {
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path} must match an allowed enum value.`);
    return;
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${describeType(schema.type)}.`);
    return;
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in record)) errors.push(`${path}.${required} is required.`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in record) validateAtPath(record[key], childSchema, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed.`);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateAtPath(item, schema.items!, `${path}[${index}]`, errors));
  }
};

export const validateStructuredOutput = (value: unknown, schema: JsonSchema): string[] => {
  const errors: string[] = [];
  validateAtPath(value, schema, '$', errors);
  return errors;
};

export const assertValidStructuredOutput = (
  value: unknown,
  schema: JsonSchema,
  provider: ProviderId,
): void => {
  if (validateStructuredOutput(value, schema).length > 0) {
    throw new ProviderError(
      'invalid_response',
      'Provider returned structured output that failed local validation.',
      { provider },
    );
  }
};
