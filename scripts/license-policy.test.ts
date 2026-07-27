import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applicationLicenseSha256,
  digestApplicationLicenseText,
  validateApplicationLicenseContract,
  validateLicenseExpression,
} from './license-policy.mjs';

const repositoryLicenseText = readFileSync(path.join(process.cwd(), 'LICENSE'), 'utf8');

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

describe('application license policy', () => {
  const validContract = {
    packageLicense: 'BUSL-1.1',
    packageLockLicense: 'BUSL-1.1',
    cargoLicense: 'BUSL-1.1',
    licenseText: repositoryLicenseText,
  };

  it('accepts aligned application metadata and the authenticated repository license', () => {
    expect(validateApplicationLicenseContract(validContract)).toBe('BUSL-1.1');
    expect(digestApplicationLicenseText(repositoryLicenseText)).toBe(applicationLicenseSha256);
  });

  it('normalizes CRLF before authenticating the exact license text', () => {
    const crlfLicense = repositoryLicenseText.replaceAll('\n', '\r\n');
    expect(validateApplicationLicenseContract({
      ...validContract,
      licenseText: crlfLicense,
    })).toBe('BUSL-1.1');
  });

  it.each(['packageLicense', 'packageLockLicense', 'cargoLicense'] as const)(
    'rejects contradictory %s metadata',
    (field) => {
      expect(() => validateApplicationLicenseContract({
        ...validContract,
        [field]: 'UNLICENSED',
      })).toThrow(/must declare the application license/i);
    },
  );

  it.each([
    ['truncation', repositoryLicenseText.slice(0, -64)],
    [
      'parameter mutation',
      repositoryLicenseText.replace('Licensed Work:        Provenance', 'Licensed Work:        Other'),
    ],
    [
      'terms mutation',
      repositoryLicenseText.replace(
        'The Licensor hereby grants you the right to copy',
        'The Licensor does not grant you the right to copy',
      ),
    ],
  ])('rejects LICENSE %s', (_label, licenseText) => {
    expect(() => validateApplicationLicenseContract({
      ...validContract,
      licenseText,
    })).toThrow(/exactly match the authenticated Business Source License/i);
  });
});
