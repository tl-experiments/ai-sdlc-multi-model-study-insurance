/**
 * format-yen.ts
 * Utilities for formatting Japanese yen currency and prefecture lookups.
 * Used throughout the Adjuster Workbench for consistent display.
 */

/**
 * Japanese prefectures (都道府県) — canonical list for validation and display.
 */
export const PREFECTURES = [
  '北海道',
  '青森県',
  '岩手県',
  '宮城県',
  '秋田県',
  '山形県',
  '福島県',
  '茨城県',
  '栃木県',
  '群馬県',
  '埼玉県',
  '千葉県',
  '東京都',
  '神奈川県',
  '新潟県',
  '富山県',
  '石川県',
  '福井県',
  '山梨県',
  '長野県',
  '岐阜県',
  '静岡県',
  '愛知県',
  '三重県',
  '滋賀県',
  '京都府',
  '大阪府',
  '兵庫県',
  '奈良県',
  '和歌山県',
  '鳥取県',
  '島根県',
  '岡山県',
  '広島県',
  '山口県',
  '徳島県',
  '香川県',
  '愛媛県',
  '高知県',
  '福岡県',
  '佐賀県',
  '長崎県',
  '熊本県',
  '大分県',
  '宮崎県',
  '鹿児島県',
  '沖縄県',
];

/**
 * Format a number as Japanese yen with ¥ symbol and thousands separator.
 * @param yen - Amount in yen (number or string)
 * @param options - Formatting options
 * @returns Formatted string, e.g. "¥1,234,567"
 */
export function formatYen(
  yen: number | string | null | undefined,
  options?: {
    showDecimals?: boolean;
    compact?: boolean;
  }
): string {
  if (yen === null || yen === undefined) {
    return '¥0';
  }

  const amount = typeof yen === 'string' ? parseFloat(yen) : yen;

  if (isNaN(amount)) {
    return '¥0';
  }

  const { showDecimals = false, compact = false } = options || {};

  if (compact) {
    if (amount >= 1_000_000_000) {
      return `¥${(amount / 1_000_000_000).toFixed(1)}B`;
    }
    if (amount >= 1_000_000) {
      return `¥${(amount / 1_000_000).toFixed(1)}M`;
    }
    if (amount >= 1_000) {
      return `¥${(amount / 1_000).toFixed(1)}K`;
    }
  }

  const formatter = new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  });

  return formatter.format(amount);
}

/**
 * Parse a yen string back to a number.
 * Handles formats like "¥1,234,567" or "1234567".
 * @param yenString - Formatted yen string
 * @returns Numeric amount, or NaN if unparseable
 */
export function parseYen(yenString: string): number {
  const cleaned = yenString.replace(/[^0-9.-]/g, '');
  return parseFloat(cleaned);
}

/**
 * Validate a Japanese postal code (郵便番号).
 * Standard format: XXX-XXXX (7 digits with hyphen).
 * @param postalCode - Postal code string
 * @returns true if valid format
 */
export function isValidPostalCode(postalCode: string): boolean {
  const pattern = /^\d{3}-\d{4}$/;
  return pattern.test(postalCode);
}

/**
 * Validate a prefecture name against the canonical list.
 * @param prefecture - Prefecture name (e.g. "東京都")
 * @returns true if valid
 */
export function isValidPrefecture(prefecture: string): boolean {
  return PREFECTURES.includes(prefecture);
}

/**
 * Get the display name for a prefecture.
 * Returns the input if valid, or a fallback string if not.
 * @param prefecture - Prefecture code or name
 * @returns Display name
 */
export function getPrefectureDisplay(prefecture: string): string {
  if (isValidPrefecture(prefecture)) {
    return prefecture;
  }
  return 'Unknown';
}

/**
 * Format a date in Japanese locale (YYYY年MM月DD日).
 * @param date - Date object or ISO string
 * @returns Formatted date string
 */
export function formatDateJapanese(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) {
    return '';
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}年${month}月${day}日`;
}

/**
 * Format a date and time in Japanese locale (YYYY年MM月DD日 HH:mm).
 * @param date - Date object or ISO string
 * @returns Formatted datetime string
 */
export function formatDateTimeJapanese(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) {
    return '';
  }
  const dateStr = formatDateJapanese(d);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${dateStr} ${hours}:${minutes}`;
}

/**
 * Format a relative time (e.g. "2 hours ago").
 * @param date - Date object or ISO string
 * @returns Relative time string
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) {
    return '';
  }

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) {
    return 'just now';
  }
  if (diffMins < 60) {
    return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  }
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  }
  if (diffDays < 7) {
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  }

  return formatDateJapanese(d);
}