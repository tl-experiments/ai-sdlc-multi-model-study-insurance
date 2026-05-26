import bcrypt from 'bcrypt';
import crypto from 'crypto';

const SALT_ROUNDS = 10;
const ALGORITHM = 'aes-256-cbc';

const getEncryptionKey = (): Buffer => {
  const secret = process.env.ENCRYPTION_KEY || process.env.APP_SECRET || 'default-super-secret-key-for-dev-only-32-bytes';
  if (secret.length === 64 && /^[0-9a-fA-F]+$/.test(secret)) {
    return Buffer.from(secret, 'hex');
  }
  return crypto.createHash('sha256').update(secret).digest();
};

/**
 * Hashes a plain text password using bcrypt.
 * @param password The plain text password to hash.
 * @returns A promise that resolves to the hashed password.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compares a plain text password with a bcrypt hash.
 * @param password The plain text password.
 * @param hash The bcrypt hash to compare against.
 * @returns A promise that resolves to true if the password matches, false otherwise.
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Encrypts a text string using AES-256-CBC.
 * @param text The plain text to encrypt.
 * @returns The encrypted string in the format "iv:encryptedData".
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an AES-256-CBC encrypted string.
 * @param encryptedText The encrypted string in the format "iv:encryptedData".
 * @returns The decrypted plain text.
 */
export function decrypt(encryptedText: string): string {
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted text format. Expected "iv:encryptedData"');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${(error as Error).message}`);
  }
}