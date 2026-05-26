// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/common/encryption.ts
//
// AES-256-GCM envelope encryption for APPI special-care PII fields.
// All `_ct` (ciphertext) Bytes fields in the Prisma schema use this module.
//
// Envelope pattern:
//   - A per-record DEK (Data Encryption Key) is generated fresh each call.
//   - The DEK is wrapped (encrypted) with the env-supplied KEK (Key Encryption Key).
//   - The stored blob is: [ version(1) | kek_id_len(1) | kek_id(N) | wrapped_dek(48) | iv(12) | tag(16) | ciphertext(M) ]
//
// KEK is supplied via environment variable ENCRYPTION_KEK_HEX (64 hex chars = 32 bytes).
// In production, replace with a KMS-backed unwrap call.
// =============================================================================

import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOB_VERSION       = 0x01;
const AES_KEY_BYTES      = 32;  // AES-256
const GCM_IV_BYTES       = 12;  // 96-bit IV — GCM standard
const GCM_TAG_BYTES      = 16;  // 128-bit auth tag
const WRAPPED_DEK_BYTES  = 48;  // AES-256-GCM wrapping of a 32-byte DEK: 32 + 16 tag
const KEK_ID_MAX_BYTES   = 255; // fits in a single length byte

// ---------------------------------------------------------------------------
// KEK loading
// ---------------------------------------------------------------------------

/**
 * Lazily-loaded KEK singleton.  Parsed once at first use so the module
 * can be imported without immediately crashing in test environments that
 * have not set the env-var (they must set it before first encrypt/decrypt).
 */
let _kek: Buffer | null = null;
let _kekId: string      = 'default';

function loadKek(): { kek: Buffer; kekId: string } {
  if (_kek !== null) {
    return { kek: _kek, kekId: _kekId };
  }

  const hexKek = process.env['ENCRYPTION_KEK_HEX'];
  if (!hexKek || hexKek.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEK_HEX must be set to a 64-character hex string (32 bytes) in the environment.',
    );
  }

  _kek   = Buffer.from(hexKek, 'hex');
  _kekId = process.env['ENCRYPTION_KEK_ID'] ?? 'default';

  if (Buffer.byteLength(_kekId, 'utf8') > KEK_ID_MAX_BYTES) {
    throw new Error('ENCRYPTION_KEK_ID must be <= 255 UTF-8 bytes.');
  }

  return { kek: _kek, kekId: _kekId };
}

/**
 * Reset the cached KEK — used in unit tests to inject a test key.
 */
export function resetKekCache(): void {
  _kek   = null;
  _kekId = 'default';
}

// ---------------------------------------------------------------------------
// Low-level AES-256-GCM primitives
// ---------------------------------------------------------------------------

function aes256GcmEncrypt(
  key:       Buffer,
  plaintext: Buffer,
  aad?:      Buffer,
): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv     = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag        = cipher.getAuthTag();

  return { iv, tag, ciphertext };
}

function aes256GcmDecrypt(
  key:        Buffer,
  iv:         Buffer,
  tag:        Buffer,
  ciphertext: Buffer,
  aad?:       Buffer,
): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------------------
// DEK wrapping / unwrapping
// ---------------------------------------------------------------------------

function wrapDek(dek: Buffer, kek: Buffer): { wrappedDek: Buffer; wrapIv: Buffer } {
  const { iv: wrapIv, tag, ciphertext } = aes256GcmEncrypt(kek, dek);
  // wrapped DEK blob = iv(12) + tag(16) + encrypted_dek(32) = 60 bytes
  const wrappedDek = Buffer.concat([wrapIv, tag, ciphertext]);
  return { wrappedDek, wrapIv };
}

function unwrapDek(wrappedDek: Buffer, kek: Buffer): Buffer {
  // layout: wrapIv(12) | tag(16) | encrypted_dek(32)
  if (wrappedDek.length !== GCM_IV_BYTES + GCM_TAG_BYTES + AES_KEY_BYTES) {
    throw new Error(
      `Invalid wrapped DEK length: expected ${GCM_IV_BYTES + GCM_TAG_BYTES + AES_KEY_BYTES}, got ${wrappedDek.length}`,
    );
  }
  const wrapIv       = wrappedDek.subarray(0, GCM_IV_BYTES);
  const tag          = wrappedDek.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const encryptedDek = wrappedDek.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);

  return aes256GcmDecrypt(kek, wrapIv, tag, encryptedDek);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a UTF-8 plaintext string into an opaque Bytes blob suitable for
 * storage in a Prisma `Bytes` (`_ct`) field.
 *
 * Blob layout (all big-endian where multi-byte):
 *   [0]           version  (0x01)
 *   [1]           kek_id_len (N, byte)
 *   [2..2+N-1]    kek_id (UTF-8)
 *   [2+N..2+N+59] wrapped_dek (wrapIv(12) | tag(16) | enc_dek(32)) = 60 bytes
 *   [2+N+60..+11] data_iv (12 bytes)
 *   [+12..+27]    data_tag (16 bytes)
 *   [+28..]       ciphertext
 */
export function encrypt(plaintext: string): Buffer {
  const { kek, kekId } = loadKek();

  // Generate a fresh DEK for this record.
  const dek = crypto.randomBytes(AES_KEY_BYTES);

  // Wrap the DEK under the KEK.
  const kekIdBuf   = Buffer.from(kekId, 'utf8');
  const { wrappedDek } = wrapDek(dek, kek);

  // Encrypt the plaintext under the DEK.  Use kekId as AAD for domain binding.
  const plaintextBuf = Buffer.from(plaintext, 'utf8');
  const { iv: dataIv, tag: dataTag, ciphertext } = aes256GcmEncrypt(dek, plaintextBuf, kekIdBuf);

  // Assemble the blob.
  const versionBuf   = Buffer.alloc(1);
  versionBuf[0]      = BLOB_VERSION;

  const kekIdLenBuf  = Buffer.alloc(1);
  kekIdLenBuf[0]     = kekIdBuf.length;

  return Buffer.concat([
    versionBuf,
    kekIdLenBuf,
    kekIdBuf,
    wrappedDek,
    dataIv,
    dataTag,
    ciphertext,
  ]);
}

/**
 * Decrypt a blob produced by `encrypt()` back to a UTF-8 string.
 * Throws if the blob is malformed, the version is unknown, or authentication fails.
 */
export function decrypt(blob: Buffer): string {
  const { kek } = loadKek();

  if (blob.length < 2) {
    throw new Error('Encrypted blob is too short.');
  }

  let offset = 0;

  // version
  const version = blob[offset++];
  if (version !== BLOB_VERSION) {
    throw new Error(`Unsupported encryption blob version: 0x${version.toString(16)}`);
  }

  // kek_id
  const kekIdLen = blob[offset++];
  if (blob.length < offset + kekIdLen) {
    throw new Error('Encrypted blob truncated at kek_id.');
  }
  const kekIdBuf = blob.subarray(offset, offset + kekIdLen);
  offset += kekIdLen;

  // wrapped DEK — 60 bytes (wrapIv:12 + tag:16 + enc_dek:32)
  const WRAPPED_DEK_FULL = GCM_IV_BYTES + GCM_TAG_BYTES + AES_KEY_BYTES; // 60
  if (blob.length < offset + WRAPPED_DEK_FULL) {
    throw new Error('Encrypted blob truncated at wrapped_dek.');
  }
  const wrappedDek = blob.subarray(offset, offset + WRAPPED_DEK_FULL);
  offset += WRAPPED_DEK_FULL;

  // data_iv
  if (blob.length < offset + GCM_IV_BYTES) {
    throw new Error('Encrypted blob truncated at data_iv.');
  }
  const dataIv = blob.subarray(offset, offset + GCM_IV_BYTES);
  offset += GCM_IV_BYTES;

  // data_tag
  if (blob.length < offset + GCM_TAG_BYTES) {
    throw new Error('Encrypted blob truncated at data_tag.');
  }
  const dataTag = blob.subarray(offset, offset + GCM_TAG_BYTES);
  offset += GCM_TAG_BYTES;

  // ciphertext
  const ciphertext = blob.subarray(offset);

  // Unwrap DEK
  const dek = unwrapDek(wrappedDek, kek);

  // Decrypt plaintext (kekId is AAD — must match what was used during encryption)
  const plaintextBuf = aes256GcmDecrypt(dek, dataIv, dataTag, ciphertext, kekIdBuf);

  return plaintextBuf.toString('utf8');
}

// ---------------------------------------------------------------------------
// Nullable helpers (convenience wrappers for optional PII fields)
// ---------------------------------------------------------------------------

/**
 * Encrypt if value is present; return null otherwise.
 * Suitable for optional `_ct` Bytes? fields.
 */
export function encryptNullable(value: string | null | undefined): Buffer | null {
  if (value == null) return null;
  return encrypt(value);
}

/**
 * Decrypt if blob is present; return null otherwise.
 */
export function decryptNullable(blob: Buffer | Uint8Array | null | undefined): string | null {
  if (blob == null) return null;
  return decrypt(Buffer.isBuffer(blob) ? blob : Buffer.from(blob));
}

// ---------------------------------------------------------------------------
// Payload hashing utility (shared by audit interceptor + seed)
// ---------------------------------------------------------------------------

/**
 * Produce a stable SHA-256 hex digest of an arbitrary JSON-serialisable payload.
 * Keys are sorted before serialisation to ensure determinism.
 */
export function hashPayload(payload: Record<string, unknown>): string {
  const normalised = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/**
 * Produce a SHA-256 hex digest of a raw string (used for content-hash of blobs,
 * inkan_seal_hash, etc.).
 */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Produce a SHA-256 hex digest of a Buffer (used for content-hash of binary blobs).
 */
export function sha256HexBuffer(input: Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}