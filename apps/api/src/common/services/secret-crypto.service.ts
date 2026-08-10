/**
 * SecretCryptoService — the ONE place OAuth/OIDC client secrets get
 * turned into bytes and back. Every module that persists a secret
 * (OrgAuthConfig, future integrations) MUST go through this service.
 * Direct crypto.createCipheriv calls elsewhere are a bug.
 *
 * Algorithm: AES-256-GCM with a per-value random 12-byte IV and the
 * built-in 16-byte auth tag. `keyVersion` is stored alongside every
 * ciphertext so we can rotate keys later (add a second key at
 * version 2, decrypt v1 with the old key, re-encrypt on next write).
 *
 * Key material: 32 raw bytes, supplied via env `SSO_ENC_KEY` as
 * standard base64 (44 chars with padding). Fails fast at
 * construction — the service will not boot with a missing / wrong
 * length key, so nothing that depends on it can accidentally accept
 * writes that couldn't be decrypted later.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Wire format for one encrypted secret. Persisted verbatim by callers. */
export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

@Injectable()
export class SecretCryptoService implements OnModuleInit {
  private readonly log = new Logger(SecretCryptoService.name);

  /** Map keyVersion -> 32-byte key. Additive so we can rotate later. */
  private readonly keys = new Map<number, Buffer>();

  /** Version used for NEW writes. Reads pick the version stored on the row. */
  private readonly currentVersion = 1;

  constructor(private readonly config: ConfigService) {
    const raw = this.config.get<string>('SSO_ENC_KEY');
    if (!raw) {
      // Fail fast — a boot without SSO_ENC_KEY would let the app
      // accept writes today that fail decryption tomorrow.
      throw new Error(
        'SSO_ENC_KEY is required — set it to a 32-byte base64 value (44 chars incl. padding). Generate with: openssl rand -base64 32',
      );
    }
    let key: Buffer;
    try {
      key = Buffer.from(raw, 'base64');
    } catch {
      throw new Error('SSO_ENC_KEY is not valid base64');
    }
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `SSO_ENC_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
      );
    }
    this.keys.set(this.currentVersion, key);
  }

  onModuleInit() {
    // Sanity-log at boot so it's obvious the crypto module wired up
    // without leaking key material. Log the version count only.
    this.log.log(`SecretCryptoService ready (versions=${this.keys.size}, current=v${this.currentVersion})`);
  }

  /**
   * Encrypt `plaintext` under the current key. Returns raw buffers so
   * callers can persist them into Bytes columns directly.
   */
  encrypt(plaintext: string): EncryptedSecret {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('encrypt(): plaintext must be a non-empty string');
    }
    const key = this.keys.get(this.currentVersion)!;
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag, keyVersion: this.currentVersion };
  }

  /**
   * Decrypt a stored secret. Throws on any tampering (wrong tag) or a
   * key-version mismatch we can't service.
   */
  decrypt(payload: EncryptedSecret): string {
    if (!payload || !payload.ciphertext || !payload.iv || !payload.tag) {
      throw new Error('decrypt(): payload is missing ciphertext/iv/tag');
    }
    if (payload.iv.length !== IV_BYTES) {
      throw new Error(`decrypt(): expected ${IV_BYTES}-byte IV, got ${payload.iv.length}`);
    }
    if (payload.tag.length !== TAG_BYTES) {
      throw new Error(`decrypt(): expected ${TAG_BYTES}-byte tag, got ${payload.tag.length}`);
    }
    const key = this.keys.get(payload.keyVersion);
    if (!key) {
      throw new Error(`decrypt(): no key registered for version ${payload.keyVersion}`);
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, payload.iv);
    decipher.setAuthTag(payload.tag);
    // Throws on wrong tag (tampering / wrong key) — propagate up.
    const plaintext = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  /**
   * "•••4a2b"-style hint for admin UI. Derived from the ciphertext
   * (not the plaintext) so it doesn't leak the last chars of the
   * real secret and doesn't require decryption to render. Stable
   * across restarts because it's a pure function of the stored bytes.
   */
  fingerprint(ciphertext: Buffer): string {
    if (!ciphertext || ciphertext.length === 0) return '';
    return crypto.createHash('sha256').update(ciphertext).digest('hex').slice(-4);
  }
}
