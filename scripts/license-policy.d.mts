export const applicationLicenseIdentifier: 'BUSL-1.1';
export const applicationLicenseSha256: 'a1795552d1786d8f443187ac3de2b4a869bc94c706cfdc74b5825cbc13a5327b';
export function validateLicenseExpression(expression: unknown): string;
export function acceptedLicenseIdentifiers(): string[];
export function digestApplicationLicenseText(licenseText: unknown): string;
export function validateApplicationLicenseContract(contract: {
  packageLicense: unknown;
  packageLockLicense: unknown;
  cargoLicense: unknown;
  licenseText: unknown;
}): 'BUSL-1.1';
