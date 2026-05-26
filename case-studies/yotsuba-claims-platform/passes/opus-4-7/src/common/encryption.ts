// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// AES-256-GCM envelope encryption for APPI Article 17 special-care PII.
//
// Design (ADR-001):
//   * A single key-encryption-key (KEK) is supplied via the environment
//     (`ENCRYPTION_KEK_BASE64`, exactly 32 bytes after base64 decode).
//   * Each plaintext value is encrypted under a freshly-generated 32-byte
//     data-encryption-key (DEK). The DEK is then wrapped under the KEK.
//   * The on-disk envelope is a single self-describing byte buffer that
//     concatenates:
//
//        ┌───────┬──────────┬────────────────┬───────────────┬──────────┬───────────┬────────────┐
//        │ ver=1 │ kek_iv12 │ wrapped_dek_32 │ kek_tag_16    │ data_iv12 │ data_tag16│ ciphertext │
//        │ 1 B   │ 12 B     │ 32 B           │ 16 B          │ 12 B      │ 16 B      │ variable   │
//        └───────┴──────────┴────────────────┴───────────────┴──────────┴───────────┴────────────┘
//
//     Total fixed overhead: 89 bytes + ciphertext length.
//   * Fields covered (per brief PII inventory + schema `_ct` columns):
//       reporter_phone_ct, reporter_email_ct,
//       insured_government_id_ct, bank_account_for_payout_ct,
//       injury_details_ct, witness_phone_ct.
//
// This module is the single source of truth for envelope crypto. Callers
// MUST go through `encryptPii` / `decryptPii` and never construct or parse
// envelopes themselves.
// ─────────────────────────────────────────────────────────────────────────

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

// ─── envelope geometry (bytes) ───────────────────────────────────────────
const ENVELOPE_VERSION = 0x01;
const VERSION_LEN = 1;
const IV_LEN = 12; // GCM standard 96-bit nonce
const TAG_LEN = 16; // GCM 128-bit auth tag
const DEK_LEN = 32; // AES-256
const KEK_LEN = 32; // AES-256

const HEADER_LEN =
  VERSION_LEN + IV_LEN + DEK_LEN + TAG_LEN + IV_LEN + TAG_LEN; // = 89

// Offsets within the envelope.
const OFF_VERSION = 0;
const OFF_KEK_IV = OFF_VERSION + VERSION_LEN;
const OFF_WRAPPED_DEK = OFF_KEK_IV + IV_LEN;
const OFF_KEK_TAG = OFF_WRAPPED_DEK + DEK_LEN;
const OFF_DATA_IV = OFF_KEK_TAG + TAG_LEN;
const OFF_DATA_TAG = OFF_DATA_IV + IV_LEN;
const OFF_CIPHERTEXT = OFF_DATA_TAG + TAG_LEN;

// ─── KEK loading ─────────────────────────────────────────────────────────

/**
 * Resolve the KEK from the environment. Cached after first read so that
 * misconfiguration is detected at boot rather than on the first request.
 *
 * The cache is keyed on the env value so tests can override the variable
 * between cases without restarting the process.
 */
let cachedKekSource: string | undefined;
let cachedKek: Buffer | undefined;

export function loadKek(): Buffer {
  const raw = process.env.ENCRYPTION_KEK_BASE64;
  if (!raw || raw.trim() === '') {
    throw new Error(
      'ENCRYPTION_KEK_BASE64 is not set; refusing to start without a key-encryption-key.',
    );
  }
  if (cachedKek && cachedKekSource === raw) {
    return cachedKek;
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('ENCRYPTION_KEK_BASE64 is not valid base64.');
  }
  // Reject base64 strings that silently decode to the wrong length.
  if (decoded.length !== KEK_LEN) {
    throw new Error(
      `ENCRYPTION_KEK_BASE64 must decode to exactly ${KEK_LEN} bytes; got ${decoded.length}.`,
    );
  }
  cachedKek = decoded;
  cachedKekSource = raw;
  return decoded;
}

/**
 * Test-only hook: drop the cached KEK so a subsequent call re-reads the
 * environment. Not exported on the public service surface.
 */
export function __resetKekCacheForTests(): void {
  cachedKek = undefined;
  cachedKekSource = undefined;
}

// ─── core primitives ─────────────────────────────────────────────────────

/**
 * Encrypt a UTF-8 plaintext into a self-describing envelope buffer.
 *
 * `null` and `undefined` pass through unchanged so callers can write
 * `record.reporter_phone_ct = encryptPii(dto.reporter_phone)` without an
 * extra branch for optional fields.
 */
export function encryptPii(plaintext: string): Buffer;
export function encryptPii(plaintext: null): null;
export function encryptPii(plaintext: undefined): undefined;
export function encryptPii(
  plaintext: string | null | undefined,
): Buffer | null | undefined;
export function encryptPii(
  plaintext: string | null | undefined,
): Buffer | null | undefined {
  if (plaintext === null) return null;
  if (plaintext === undefined) return undefined;
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptPii expects a string plaintext.');
  }

  const kek = loadKek();
  const dek = randomBytes(DEK_LEN);
  const kekIv = randomBytes(IV_LEN);
  const dataIv = randomBytes(IV_LEN);

  // Wrap the DEK under the KEK.
  const kekCipher = createCipheriv('aes-256-gcm', kek, kekIv);
  const wrappedDek = Buffer.concat([kekCipher.update(dek), kekCipher.final()]);
  const kekTag = kekCipher.getAuthTag();

  // Encrypt the payload under the DEK.
  const dataCipher = createCipheriv('aes-256-gcm', dek, dataIv);
  const ciphertext = Buffer.concat([
    dataCipher.update(plaintext, 'utf8'),
    dataCipher.final(),
  ]);
  const dataTag = dataCipher.getAuthTag();

  // Defence-in-depth: zeroise the DEK once it has been wrapped+used.
  dek.fill(0);

  const envelope = Buffer.alloc(HEADER_LEN + ciphertext.length);
  envelope.writeUInt8(ENVELOPE_VERSION, OFF_VERSION);
  kekIv.copy(envelope, OFF_KEK_IV);
  wrappedDek.copy(envelope, OFF_WRAPPED_DEK);
  kekTag.copy(envelope, OFF_KEK_TAG);
  dataIv.copy(envelope, OFF_DATA_IV);
  dataTag.copy(envelope, OFF_DATA_TAG);
  ciphertext.copy(envelope, OFF_CIPHERTEXT);

  return envelope;
}

/**
 * Decrypt an envelope produced by `encryptPii`. Returns the original UTF-8
 * plaintext.
 *
 * Throws on:
 *   * unknown envelope version,
 *   * truncated buffers,
 *   * KEK-wrap auth-tag mismatch (wrong KEK or tampered DEK),
 *   * data auth-tag mismatch (wrong DEK or tampered ciphertext).
 */
export function decryptPii(envelope: Buffer): string;
export function decryptPii(envelope: null): null;
export function decryptPii(envelope: undefined): undefined;
export function decryptPii(
  envelope: Buffer | Uint8Array | null | undefined,
): string | null | undefined;
export function decryptPii(
  envelope: Buffer | Uint8Array | null | undefined,
): string | null | undefined {
  if (envelope === null) return null;
  if (envelope === undefined) return undefined;

  const buf = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  if (buf.length < HEADER_LEN) {
    throw new Error('Ciphertext envelope is truncated.');
  }

  const version = buf.readUInt8(OFF_VERSION);
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported ciphertext envelope version: ${version}.`);
  }

  const kek = loadKek();
  const kekIv = buf.subarray(OFF_KEK_IV, OFF_KEK_IV + IV_LEN);
  const wrappedDek = buf.subarray(OFF_WRAPPED_DEK, OFF_WRAPPED_DEK + DEK_LEN);
  const kekTag = buf.subarray(OFF_KEK_TAG, OFF_KEK_TAG + TAG_LEN);
  const dataIv = buf.subarray(OFF_DATA_IV, OFF_DATA_IV + IV_LEN);
  const dataTag = buf.subarray(OFF_DATA_TAG, OFF_DATA_TAG + TAG_LEN);
  const ciphertext = buf.subarray(OFF_CIPHERTEXT);

  // Unwrap the DEK.
  const kekDecipher = createDecipheriv('aes-256-gcm', kek, kekIv);
  kekDecipher.setAuthTag(kekTag);
  let dek: Buffer;
  try {
    dek = Buffer.concat([kekDecipher.update(wrappedDek), kekDecipher.final()]);
  } catch {
    throw new Error(
      'Failed to unwrap data-encryption-key (KEK mismatch or tampered envelope).',
    );
  }

  try {
    const dataDecipher = createDecipheriv('aes-256-gcm', dek, dataIv);
    dataDecipher.setAuthTag(dataTag);
    const plaintext = Buffer.concat([
      dataDecipher.update(ciphertext),
      dataDecipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error(
      'Failed to decrypt payload (DEK mismatch or tampered ciphertext).',
    );
  } finally {
    dek.fill(0);
  }
}

// ─── content-hash helpers (evidence, audit payloads, inkan seals) ────────

/**
 * SHA-256 of a UTF-8 string or raw buffer, returned as lowercase hex.
 *
 * Used by:
 *   * `Evidence.content_hash` — tamper detection over uploaded blobs.
 *   * `AuditEvent.payload_hash` — content-binding of audited mutations.
 *   * `WitnessStatement.inkan_seal_hash` — digital seal acknowledgement.
 */
export function sha256Hex(input: string | Buffer | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof input === 'string') {
    hash.update(input, 'utf8');
  } else {
    hash.update(input);
  }
  return hash.digest('hex');
}

/**
 * Stable, canonical JSON stringification suitable for hashing audit
 * payloads. Object keys are sorted recursively so that semantically equal
 * payloads produce identical hashes regardless of property insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Constant-time equality check for hex-encoded digests. Use this when
 * comparing user-supplied hashes (e.g. an `inkan_seal_hash` re-verification
 * request) against stored values to avoid timing oracles.
 */
export function constantTimeHexEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}