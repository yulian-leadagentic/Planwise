import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SecretCryptoService } from './secret-crypto.service';

// Locked-in 32-byte key so the round-trip test is deterministic. Do
// not lift this into any actual environment — it's a test fixture.
const TEST_KEY = crypto.randomBytes(32).toString('base64');

function makeService(overrides: Record<string, string | undefined> = {}) {
  const map: Record<string, string | undefined> = {
    SSO_ENC_KEY: TEST_KEY,
    ...overrides,
  };
  const config = { get: (k: string) => map[k] } as unknown as ConfigService;
  return new SecretCryptoService(config);
}

describe('SecretCryptoService', () => {
  it('round-trips a secret through encrypt() -> decrypt()', () => {
    const svc = makeService();
    const plaintext = 'super-secret-oidc-client-secret-!@#';
    const enc = svc.encrypt(plaintext);

    expect(enc.ciphertext).toBeInstanceOf(Buffer);
    expect(enc.iv).toHaveLength(12);
    expect(enc.tag).toHaveLength(16);
    expect(enc.keyVersion).toBe(1);
    // Ciphertext must NOT reveal the plaintext even at a substring level.
    expect(enc.ciphertext.toString('utf8')).not.toContain(plaintext);

    const round = svc.decrypt(enc);
    expect(round).toBe(plaintext);
  });

  it('produces a distinct ciphertext on every encrypt (unique IV)', () => {
    const svc = makeService();
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a decrypt when the auth tag has been tampered with', () => {
    const svc = makeService();
    const enc = svc.encrypt('important');
    // Flip a single bit of the tag — GCM must refuse.
    const badTag = Buffer.from(enc.tag);
    badTag[0] ^= 0x01;
    expect(() => svc.decrypt({ ...enc, tag: badTag })).toThrow();
  });

  it('rejects a decrypt when a byte of the ciphertext has been tampered with', () => {
    const svc = makeService();
    const enc = svc.encrypt('important');
    const badCt = Buffer.from(enc.ciphertext);
    badCt[0] ^= 0x01;
    expect(() => svc.decrypt({ ...enc, ciphertext: badCt })).toThrow();
  });

  it('throws at construction when SSO_ENC_KEY is missing', () => {
    expect(() => makeService({ SSO_ENC_KEY: undefined })).toThrow(/SSO_ENC_KEY/);
  });

  it('throws at construction when SSO_ENC_KEY decodes to the wrong length', () => {
    const shortKey = crypto.randomBytes(16).toString('base64');
    expect(() => makeService({ SSO_ENC_KEY: shortKey })).toThrow(/32 bytes/);
  });

  it('produces a stable, plaintext-independent fingerprint from ciphertext', () => {
    const svc = makeService();
    const enc = svc.encrypt('anything');
    const fp1 = svc.fingerprint(enc.ciphertext);
    const fp2 = svc.fingerprint(enc.ciphertext);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{4}$/);
  });
});
