import { describe, expect, it } from 'vitest';
import { validateLicenseExpression } from './license-policy.mjs';

describe('JavaScript release license policy', () => {
  it('accepts the repository permissive and notice-bearing expressions', () => {
    for (const expression of [
      'MIT',
      'Apache-2.0 OR MIT',
      'MIT AND ISC',
      '(BSD-2-Clause OR MIT OR Apache-2.0)',
      'MPL-2.0',
      'CC-BY-4.0',
    ]) {
      expect(validateLicenseExpression(expression)).toBe(expression);
    }
  });

  it('rejects unknown, malformed, copyleft, and plus expressions', () => {
    for (const expression of ['', 'not-a-license', 'GPL-3.0-only', 'MIT+', 'MIT AND GPL-2.0-only']) {
      expect(() => validateLicenseExpression(expression)).toThrow(/required|invalid|outside/i);
    }
  });
});
