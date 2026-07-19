import { describe, expect, it } from 'vitest';
import { verifyUpdaterSignature } from './updater-signature.mjs';

const rawPublicKey = `untrusted comment: minisign public key E7620F1842B4E81F
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3`;
const rawSignature = `untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==`;
const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const publicKey = encode(rawPublicKey);
const signature = encode(rawSignature);

describe('updater Minisign verification', () => {
  it('verifies the artifact and trusted comment against the exact public key', () => {
    expect(verifyUpdaterSignature(publicKey, signature, Buffer.from('test'))).toBe(true);
  });

  it('rejects artifact, public-key, and trusted-comment tampering', () => {
    expect(() => verifyUpdaterSignature(publicKey, signature, Buffer.from('Test'))).toThrow(/artifact signature/i);
    expect(() => verifyUpdaterSignature(
      encode(rawPublicKey.replace(/3$/, '2')),
      signature,
      Buffer.from('test'),
    )).toThrow(/artifact signature/i);
    expect(() => verifyUpdaterSignature(
      publicKey,
      encode(rawSignature.replace('file:test', 'file:other')),
      Buffer.from('test'),
    )).toThrow(/trusted-comment/i);
  });

  it('does not treat the Minisign untrusted comment as authenticated data', () => {
    const relabeled = encode(rawPublicKey.replace('E7620F1842B4E81F', 'operator label'));
    expect(verifyUpdaterSignature(relabeled, signature, Buffer.from('test'))).toBe(true);
  });

  it('rejects legacy signatures for updater artifacts', () => {
    const legacy = encode(rawSignature.replace('\nRUQ', '\nRWQ'));
    expect(() => verifyUpdaterSignature(publicKey, legacy, Buffer.from('test'))).toThrow(/prehash/i);
  });

  it('rejects raw Minisign text without the Tauri transport envelope', () => {
    expect(() => verifyUpdaterSignature(rawPublicKey, signature, Buffer.from('test'))).toThrow(/transport/i);
    expect(() => verifyUpdaterSignature(publicKey, rawSignature, Buffer.from('test'))).toThrow(/transport/i);
  });
});
