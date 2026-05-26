/**
 * Helper to check if a value is a plain object.
 */
function isPlainObject(val: any): boolean {
  if (val === null || typeof val !== 'object') return false;
  const proto = Object.getPrototypeOf(val);
  return proto === null || proto === Object.prototype;
}

/**
 * Helper to mask digits in a string while keeping the last N digits visible.
 * Preserves non-digit formatting characters.
 */
function maskDigitsKeepLast(value: string, keepCount: number = 4): string {
  if (!value || typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length <= keepCount) {
    return value.replace(/\d/g, '*');
  }
  const maskCount = digits.length - keepCount;
  let count = 0;
  return value
    .split('')
    .map((char) => {
      if (/\d/.test(char)) {
        if (count < maskCount) {
          count++;
          return '*';
        }
      }
      return char;
    })
    .join('');
}

/**
 * Masks an email address, keeping the first and last characters of the local part
 * and preserving the domain.
 * @param email The email address to mask.
 */
export function maskEmail(email: string): string {
  if (!email || typeof email !== 'string') return '';
  const parts = email.split('@');
  if (parts.length !== 2) {
    return '***';
  }
  const [local, domain] = parts;
  if (local.length <= 2) {
    return `${'*'.repeat(local.length)}@${domain}`;
  }
  const first = local.charAt(0);
  const last = local.charAt(local.length - 1);
  return `${first}${'*'.repeat(Math.max(3, local.length - 2))}${last}@${domain}`;
}

/**
 * Masks a phone number, keeping the last 4 digits visible and preserving formatting.
 * @param phone The phone number to mask.
 */
export function maskPhone(phone: string): string {
  return maskDigitsKeepLast(phone, 4);
}

/**
 * Masks a credit card number, keeping the last 4 digits visible and preserving formatting.
 * @param cc The credit card number to mask.
 */
export function maskCreditCard(cc: string): string {
  return maskDigitsKeepLast(cc, 4);
}

/**
 * Masks a general string, keeping the last N characters visible.
 * @param text The string to mask.
 * @param visibleCount The number of characters to keep visible at the end.
 */
export function maskString(text: string, visibleCount: number = 4): string {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= visibleCount) {
    return '*'.repeat(text.length);
  }
  return '*'.repeat(text.length - visibleCount) + text.slice(-visibleCount);
}

const DEFAULT_KEYS_TO_MASK = [
  'email',
  'phone',
  'phonenumber',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'creditcard',
  'cardnumber',
  'ssn',
  'secret',
  'authorization',
  'pin',
];

/**
 * Recursively traverses an object or array and masks sensitive fields.
 * @param obj The object or array to mask.
 * @param customKeysToMask Optional list of custom keys to mask.
 */
export function maskObject(obj: any, customKeysToMask?: string[]): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => maskObject(item, customKeysToMask));
  }

  if (isPlainObject(obj)) {
    const maskedObj: Record<string, any> = {};
    const keysToMask = (customKeysToMask || DEFAULT_KEYS_TO_MASK).map((k) => k.toLowerCase());

    for (const key of Object.keys(obj)) {
      const value = obj[key];
      const lowerKey = key.toLowerCase();

      const shouldMask = keysToMask.some((k) => lowerKey.includes(k));

      if (shouldMask) {
        if (typeof value === 'string') {
          if (lowerKey.includes('email')) {
            maskedObj[key] = maskEmail(value);
          } else if (lowerKey.includes('phone')) {
            maskedObj[key] = maskPhone(value);
          } else if (lowerKey.includes('card')) {
            maskedObj[key] = maskCreditCard(value);
          } else {
            maskedObj[key] = maskString(value, 0);
          }
        } else {
          maskedObj[key] = '*****';
        }
      } else {
        maskedObj[key] = maskObject(value, customKeysToMask);
      }
    }
    return maskedObj;
  }

  return obj;
}