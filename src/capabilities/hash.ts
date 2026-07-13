import crypto from 'node:crypto';

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const serialize = (value: unknown, ancestors: Set<object>): string => {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Stable JSON requires finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('Stable JSON does not support cycles.');
    ancestors.add(value);
    const output = `[${value.map((item) => serialize(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return output;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('Stable JSON does not support cycles.');
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const output = `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`)
      .join(',')}}`;
    ancestors.delete(value);
    return output;
  }
  throw new Error(`Stable JSON does not support ${typeof value}.`);
};

export const stableJson = (value: unknown): string => serialize(value, new Set());
export const stableSha256 = (value: unknown): string => crypto.createHash('sha256').update(stableJson(value)).digest('hex');
export const sha256Text = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
