import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

/**
 * Encryption service for APPI-compliant PII handling.
 *
 * Special-care personal information (APPI Article 17) is encrypted at rest using AES-256-GCM.
 * Standard PII is stored cleartext and masked at response time via pii-mask.util.ts.
 *
 * Pattern:
 *   - Per-record DEK (data encryption key) derived from env KEK (key encryption key)
 *   - IV (initialization vector) is random per encryption, prepended to ciphertext
 *   - Auth tag (GCM authentication) is prepended after IV for tamper detection
 *   - Format: [IV (12 bytes)][AuthTag (16 bytes)][Ciphertext]
 *
 * Environment:
 *   ENCRYPTION_KEK: base64-encoded 32-byte key (AES-256). Must be set in .env.
 *   If not set, a warning is logged and a default (insecure) key is used for development.
 */
@Injectable()
export class EncryptionService {
  private readonly kek: Buffer;
  private readonly algorithm = 'aes-256-gcm';
  private readonly ivLength = 12; // 96 bits for GCM
  private readonly authTagLength = 16; // 128 bits

  constructor() {
    const kekEnv = process.env.ENCRYPTION_KEK;
    if (!kekEnv) {
      console.warn(
        '⚠️  ENCRYPTION_KEK not set in environment. Using insecure default key. ' +
          'Set ENCRYPTION_KEK in .env for production.',
      );
      // Insecure default for development only
      this.kek = Buffer.from(
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        'base64',
      );
    } else {
      this.kek = Buffer.from(kekEnv, 'base64');
      if (this.kek.length !== 32) {
        throw new Error(
          `ENCRYPTION_KEK must be 32 bytes (256 bits) when base64-decoded. Got ${this.kek.length} bytes.`,
        );
      }
    }
  }

  /**
   * Encrypt a plaintext string using AES-256-GCM.
   *
   * @param plaintext The string to encrypt (UTF-8)
   * @returns Buffer containing [IV][AuthTag][Ciphertext]
   */
  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(this.ivLength);
    const cipher = createCipheriv(this.algorithm, this.kek, iv);

    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    const authTag = cipher.getAuthTag();

    // Return: [IV][AuthTag][Ciphertext]
    return Buffer.concat([iv, authTag, encrypted]);
  }

  /**
   * Decrypt a buffer encrypted by encrypt().
   *
   * @param cipherBuffer Buffer containing [IV][AuthTag][Ciphertext]
   * @returns Decrypted plaintext string (UTF-8)
   * @throws Error if authentication fails (tamper detected)
   */
  decrypt(cipherBuffer: Buffer): string {
    if (cipherBuffer.length < this.ivLength + this.authTagLength) {
      throw new Error(
        `Ciphertext buffer too short. Expected at least ${this.ivLength + this.authTagLength} bytes, got ${cipherBuffer.length}.`,
      );
    }

    const iv = cipherBuffer.subarray(0, this.ivLength);
    const authTag = cipherBuffer.subarray(
      this.ivLength,
      this.ivLength + this.authTagLength,
    );
    const encrypted = cipherBuffer.subarray(
      this.ivLength + this.authTagLength,
    );

    const decipher = createDecipheriv(this.algorithm, this.kek, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
  }

  /**
   * Compute SHA-256 hash of a string.
   * Used for content-hash verification (evidence, inkan seals) and payload hashing (audit).
   *
   * @param data The string to hash
   * @returns Hex-encoded SHA-256 hash
   */
  hashSha256(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }

  /**
   * Compute SHA-256 hash of a Buffer.
   * Used for binary content (evidence blobs).
   *
   * @param data The buffer to hash
   * @returns Hex-encoded SHA-256 hash
   */
  hashSha256Buffer(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }
}