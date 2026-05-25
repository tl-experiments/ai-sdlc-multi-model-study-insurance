/**
 * AES-256-GCM encryption for PII fields. Per-record DEK wrapped by env-supplied KEK.
 * Blob layout: [wrappedDek(32) | wrapTag(16) | iv(12) | tag(16) | ct(N)] base64-encoded.
 */
import * as crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const DEK_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKek(): Buffer {
  const hex = process.env.KEK_HEX;
  if (!hex || hex.length !== 64) throw new Error("KEK_HEX must be set to 64 hex chars (32 bytes)");
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): Buffer {
  const dek = crypto.randomBytes(DEK_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const kek = loadKek();
  const dekWrapCipher = crypto.createCipheriv(ALGO, kek, iv);
  const wrappedDek = Buffer.concat([dekWrapCipher.update(dek), dekWrapCipher.final()]);
  const wrapTag = dekWrapCipher.getAuthTag();
  return Buffer.concat([wrappedDek, wrapTag, iv, tag, ct]);
}

export function decrypt(blob: Buffer): string {
  const wrappedDek = blob.subarray(0, DEK_LEN);
  const wrapTag = blob.subarray(DEK_LEN, DEK_LEN + TAG_LEN);
  const iv = blob.subarray(DEK_LEN + TAG_LEN, DEK_LEN + TAG_LEN + IV_LEN);
  const tag = blob.subarray(DEK_LEN + TAG_LEN + IV_LEN, DEK_LEN + TAG_LEN + IV_LEN + TAG_LEN);
  const ct = blob.subarray(DEK_LEN + TAG_LEN + IV_LEN + TAG_LEN);
  const kek = loadKek();
  const dekUnwrap = crypto.createDecipheriv(ALGO, kek, iv);
  dekUnwrap.setAuthTag(wrapTag);
  const dek = Buffer.concat([dekUnwrap.update(wrappedDek), dekUnwrap.final()]);
  const decipher = crypto.createDecipheriv(ALGO, dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function encryptToString(plaintext: string): string { return encrypt(plaintext).toString("base64"); }
export function decryptFromString(b64: string): string { return decrypt(Buffer.from(b64, "base64")); }
export function maybeDecrypt(b64: string | null | undefined): string | null {
  if (!b64) return null;
  try { return decryptFromString(b64); } catch { return null; }
}
