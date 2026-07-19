export function validateUpdaterPublicKey(publicKeyText: string): string;
export function verifyUpdaterSignature(
  publicKeyText: string,
  signatureText: string,
  artifact: Uint8Array,
): true;
