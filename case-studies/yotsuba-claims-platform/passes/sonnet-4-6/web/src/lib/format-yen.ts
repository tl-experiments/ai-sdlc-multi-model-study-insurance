/**
 * format-yen.ts
 *
 * Utility functions for:
 *  1. Formatting Japanese Yen amounts (¥) — Decimal-safe, monospace-friendly.
 *  2. Prefecture (都道府県) lookups and validation.
 *
 * Design constraints:
 *  - No `number` type for yen values; accepts `string | bigint` to avoid
 *    IEEE-754 precision loss on large Decimal(15,0) values from Prisma.
 *  - Prefecture list is the canonical 47 prefectures used for FNOL validation
 *    (loss_location_prefecture field) and APPI-tier masking.
 */

// ─── Yen formatting ──────────────────────────────────────────────────────────

/**
 * Represents a yen amount as it comes back from the API: a Prisma Decimal
 * serialised to string, or a bigint for computed values.
 */
export type YenAmount = string | bigint | number;

/**
 * Format a yen amount into a localised display string.
 *
 * Examples:
 *   formatYen('1500000')   → '¥1,500,000'
 *   formatYen(0)           → '¥0'
 *   formatYen('100000000') → '¥100,000,000'
 *
 * @param amount  - Raw yen value. Accepts string (Prisma Decimal), bigint, or
 *                  number. Fractional parts are truncated (yen has no decimal).
 * @param opts    - Optional formatting overrides.
 */
export function formatYen(
  amount: YenAmount,
  opts: {
    /** Show the ¥ symbol. Default: true. */
    symbol?: boolean;
    /** Use compact notation (e.g. ¥1.5M, ¥100M). Default: false. */
    compact?: boolean;
    /** Locale for number formatting. Default: 'ja-JP'. */
    locale?: string;
  } = {},
): string {
  const { symbol = true, compact = false, locale = 'ja-JP' } = opts;

  // Normalise to BigInt to avoid floating-point issues with large Decimal(15,0)
  // values. We truncate any fractional component — yen is always an integer.
  let intVal: bigint;
  try {
    if (typeof amount === 'bigint') {
      intVal = amount;
    } else if (typeof amount === 'number') {
      intVal = BigInt(Math.trunc(amount));
    } else {
      // string — strip any fractional part before converting
      const stripped = amount.split('.')[0].replace(/[^\-0-9]/g, '');
      intVal = BigInt(stripped === '' || stripped === '-' ? 0 : stripped);
    }
  } catch {
    // Fallback for malformed input
    intVal = 0n;
  }

  const absVal = intVal < 0n ? -intVal : intVal;
  const sign = intVal < 0n ? '-' : '';
  const prefix = symbol ? '¥' : '';

  if (compact) {
    return `${sign}${prefix}${compactYen(absVal, locale)}`;
  }

  // Use Intl.NumberFormat for locale-aware grouping separators.
  // We convert back to number for Intl; safe because Number(BigInt) is exact
  // up to 2^53-1 ≈ 9 quadrillion, which exceeds Decimal(15,0) max of ~999T.
  const formatter = new Intl.NumberFormat(locale, {
    style: 'decimal',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    useGrouping: true,
  });

  return `${sign}${prefix}${formatter.format(Number(absVal))}`;
}

/**
 * Compact yen notation for large amounts displayed in space-constrained UI
 * (e.g. reserve tables, queue list).
 *
 *   ¥100,000,000 → ¥100M
 *   ¥1,500,000   → ¥1.5M
 *   ¥500,000     → ¥500K
 *   ¥999         → ¥999
 *
 * Internal helper — call via `formatYen(amount, { compact: true })`.
 */
function compactYen(absVal: bigint, locale: string): string {
  const formatter = (val: number, fractionDigits: number) =>
    new Intl.NumberFormat(locale, {
      style: 'decimal',
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: 0,
      useGrouping: false,
    }).format(val);

  if (absVal >= 1_000_000_000_000n) {
    // Trillions (兆) — e.g. ¥3T
    const t = Number(absVal) / 1_000_000_000_000;
    return `${formatter(t, 1)}T`;
  }
  if (absVal >= 1_000_000_000n) {
    // Billions (十億)
    const b = Number(absVal) / 1_000_000_000;
    return `${formatter(b, 1)}B`;
  }
  if (absVal >= 1_000_000n) {
    // Millions (百万)
    const m = Number(absVal) / 1_000_000;
    return `${formatter(m, 1)}M`;
  }
  if (absVal >= 1_000n) {
    // Thousands (千)
    const k = Number(absVal) / 1_000;
    return `${formatter(k, 1)}K`;
  }
  return formatter(Number(absVal), 0);
}

/**
 * Parse a formatted yen string back to a plain integer string suitable for
 * API submission (Prisma Decimal field).
 *
 * Examples:
 *   parseYenInput('¥1,500,000')  → '1500000'
 *   parseYenInput('1500000')     → '1500000'
 *   parseYenInput('')            → '0'
 *
 * Returns a string to avoid precision issues — callers send this directly to
 * the API body as `proposed_yen`.
 */
export function parseYenInput(raw: string): string {
  const stripped = raw.replace(/[¥,\s]/g, '').replace(/[^\-0-9]/g, '');
  if (stripped === '' || stripped === '-') return '0';
  return stripped;
}

/**
 * Reserve approval tier thresholds (JFSA / ADR-005).
 * Named constants so UI can colour-code the tier without duplicating magic numbers.
 */
export const RESERVE_TIERS = {
  /** Below this: no approval required (adjuster self-approves). */
  MANAGER_APPROVAL_THRESHOLD_YEN: 1_000_000n,
  /** Below this: manager-only approval. Above: claims-director required. */
  DIRECTOR_APPROVAL_THRESHOLD_YEN: 10_000_000n,
  /** JFSA notification threshold. */
  JFSA_NOTIFICATION_THRESHOLD_YEN: 100_000_000n,
} as const;

export type ReserveApprovalTier = 'self' | 'manager' | 'director';

/**
 * Determine which approval tier a proposed reserve amount falls into.
 *
 * @param proposedYen - Raw Decimal string or bigint from the API.
 */
export function getReserveApprovalTier(proposedYen: YenAmount): ReserveApprovalTier {
  let val: bigint;
  try {
    if (typeof proposedYen === 'bigint') {
      val = proposedYen < 0n ? -proposedYen : proposedYen;
    } else if (typeof proposedYen === 'number') {
      val = BigInt(Math.abs(Math.trunc(proposedYen)));
    } else {
      const stripped = proposedYen.split('.')[0].replace(/[^0-9]/g, '');
      val = BigInt(stripped === '' ? 0 : stripped);
    }
  } catch {
    val = 0n;
  }

  if (val > RESERVE_TIERS.DIRECTOR_APPROVAL_THRESHOLD_YEN) return 'director';
  if (val > RESERVE_TIERS.MANAGER_APPROVAL_THRESHOLD_YEN) return 'manager';
  return 'self';
}

/**
 * Returns true if the amount crosses the JFSA notification threshold (¥100M).
 */
export function exceedsJfsaThreshold(proposedYen: YenAmount): boolean {
  let val: bigint;
  try {
    if (typeof proposedYen === 'bigint') {
      val = proposedYen < 0n ? -proposedYen : proposedYen;
    } else if (typeof proposedYen === 'number') {
      val = BigInt(Math.abs(Math.trunc(proposedYen)));
    } else {
      const stripped = proposedYen.split('.')[0].replace(/[^0-9]/g, '');
      val = BigInt(stripped === '' ? 0 : stripped);
    }
  } catch {
    val = 0n;
  }
  return val >= RESERVE_TIERS.JFSA_NOTIFICATION_THRESHOLD_YEN;
}

// ─── Prefecture (都道府県) data ────────────────────────────────────────────────

/**
 * A single prefecture entry.
 */
export interface Prefecture {
  /** JIS X 0401 two-digit code (e.g. '13' for Tokyo). */
  code: string;
  /** Romanised name (Hepburn). */
  name: string;
  /** Kanji / kana name as used in postal addresses. */
  nameJa: string;
  /** Region grouping (Honshu, Hokkaido, Tohoku, etc.) */
  region: PrefectureRegion;
}

export type PrefectureRegion =
  | 'Hokkaido'
  | 'Tohoku'
  | 'Kanto'
  | 'Chubu'
  | 'Kinki'
  | 'Chugoku'
  | 'Shikoku'
  | 'Kyushu'
  | 'Okinawa';

/**
 * Canonical list of Japan's 47 prefectures.
 * JIS X 0401 codes used for loss_location_prefecture validation (FNOL).
 * Matches the set accepted by the backend `PrefectureValidator`.
 */
export const PREFECTURES: ReadonlyArray<Prefecture> = [
  // Hokkaido
  { code: '01', name: 'Hokkaido',    nameJa: '北海道', region: 'Hokkaido' },

  // Tohoku
  { code: '02', name: 'Aomori',      nameJa: '青森県', region: 'Tohoku' },
  { code: '03', name: 'Iwate',        nameJa: '岩手県', region: 'Tohoku' },
  { code: '04', name: 'Miyagi',       nameJa: '宮城県', region: 'Tohoku' },
  { code: '05', name: 'Akita',        nameJa: '秋田県', region: 'Tohoku' },
  { code: '06', name: 'Yamagata',     nameJa: '山形県', region: 'Tohoku' },
  { code: '07', name: 'Fukushima',    nameJa: '福島県', region: 'Tohoku' },

  // Kanto
  { code: '08', name: 'Ibaraki',      nameJa: '茨城県', region: 'Kanto' },
  { code: '09', name: 'Tochigi',      nameJa: '栃木県', region: 'Kanto' },
  { code: '10', name: 'Gunma',        nameJa: '群馬県', region: 'Kanto' },
  { code: '11', name: 'Saitama',      nameJa: '埼玉県', region: 'Kanto' },
  { code: '12', name: 'Chiba',        nameJa: '千葉県', region: 'Kanto' },
  { code: '13', name: 'Tokyo',        nameJa: '東京都', region: 'Kanto' },
  { code: '14', name: 'Kanagawa',     nameJa: '神奈川県', region: 'Kanto' },

  // Chubu
  { code: '15', name: 'Niigata',      nameJa: '新潟県', region: 'Chubu' },
  { code: '16', name: 'Toyama',       nameJa: '富山県', region: 'Chubu' },
  { code: '17', name: 'Ishikawa',     nameJa: '石川県', region: 'Chubu' },
  { code: '18', name: 'Fukui',        nameJa: '福井県', region: 'Chubu' },
  { code: '19', name: 'Yamanashi',    nameJa: '山梨県', region: 'Chubu' },
  { code: '20', name: 'Nagano',       nameJa: '長野県', region: 'Chubu' },
  { code: '21', name: 'Gifu',         nameJa: '岐阜県', region: 'Chubu' },
  { code: '22', name: 'Shizuoka',     nameJa: '静岡県', region: 'Chubu' },
  { code: '23', name: 'Aichi',        nameJa: '愛知県', region: 'Chubu' },

  // Kinki
  { code: '24', name: 'Mie',          nameJa: '三重県', region: 'Kinki' },
  { code: '25', name: 'Shiga',        nameJa: '滋賀県', region: 'Kinki' },
  { code: '26', name: 'Kyoto',        nameJa: '京都府', region: 'Kinki' },
  { code: '27', name: 'Osaka',        nameJa: '大阪府', region: 'Kinki' },
  { code: '28', name: 'Hyogo',        nameJa: '兵庫県', region: 'Kinki' },
  { code: '29', name: 'Nara',         nameJa: '奈良県', region: 'Kinki' },
  { code: '30', name: 'Wakayama',     nameJa: '和歌山県', region: 'Kinki' },

  // Chugoku
  { code: '31', name: 'Tottori',      nameJa: '鳥取県', region: 'Chugoku' },
  { code: '32', name: 'Shimane',      nameJa: '島根県', region: 'Chugoku' },
  { code: '33', name: 'Okayama',      nameJa: '岡山県', region: 'Chugoku' },
  { code: '34', name: 'Hiroshima',    nameJa: '広島県', region: 'Chugoku' },
  { code: '35', name: 'Yamaguchi',    nameJa: '山口県', region: 'Chugoku' },

  // Shikoku
  { code: '36', name: 'Tokushima',    nameJa: '徳島県', region: 'Shikoku' },
  { code: '37', name: 'Kagawa',       nameJa: '香川県', region: 'Shikoku' },
  { code: '38', name: 'Ehime',        nameJa: '愛媛県', region: 'Shikoku' },
  { code: '39', name: 'Kochi',        nameJa: '高知県', region: 'Shikoku' },

  // Kyushu
  { code: '40', name: 'Fukuoka',      nameJa: '福岡県', region: 'Kyushu' },
  { code: '41', name: 'Saga',         nameJa: '佐賀県', region: 'Kyushu' },
  { code: '42', name: 'Nagasaki',     nameJa: '長崎県', region: 'Kyushu' },
  { code: '43', name: 'Kumamoto',     nameJa: '熊本県', region: 'Kyushu' },
  { code: '44', name: 'Oita',         nameJa: '大分県', region: 'Kyushu' },
  { code: '45', name: 'Miyazaki',     nameJa: '宮崎県', region: 'Kyushu' },
  { code: '46', name: 'Kagoshima',    nameJa: '鹿児島県', region: 'Kyushu' },

  // Okinawa
  { code: '47', name: 'Okinawa',      nameJa: '沖縄県', region: 'Okinawa' },
] as const;

/** Set of valid prefecture names (Japanese) for O(1) lookup. */
const PREFECTURE_JA_SET = new Set<string>(PREFECTURES.map((p) => p.nameJa));

/** Set of valid prefecture names (romanised) for O(1) lookup. */
const PREFECTURE_NAME_SET = new Set<string>(PREFECTURES.map((p) => p.name));

/** Set of valid JIS X 0401 codes for O(1) lookup. */
const PREFECTURE_CODE_SET = new Set<string>(PREFECTURES.map((p) => p.code));

/**
 * Validate a prefecture value against the canonical list.
 * Accepts code (e.g. '13'), romanised name (e.g. 'Tokyo'), or kanji name
 * (e.g. '東京都').
 *
 * Used by FNOL form validation before submission.
 */
export function isValidPrefecture(value: string): boolean {
  return (
    PREFECTURE_CODE_SET.has(value) ||
    PREFECTURE_NAME_SET.has(value) ||
    PREFECTURE_JA_SET.has(value)
  );
}

/**
 * Look up a Prefecture by any identifier (code, romanised name, or kanji name).
 * Returns `undefined` if not found.
 */
export function findPrefecture(value: string): Prefecture | undefined {
  return PREFECTURES.find(
    (p) => p.code === value || p.name === value || p.nameJa === value,
  );
}

/**
 * Get a display label for a prefecture value as stored in the DB
 * (`loss_location_prefecture` field — stored as kanji name).
 *
 * For roles that receive prefecture-only granularity (APPI masking),
 * this provides the human-readable label.
 *
 * @param value  - The stored prefecture value (any format).
 * @param lang   - 'ja' returns kanji name; 'en' returns romanised.
 */
export function formatPrefecture(
  value: string,
  lang: 'ja' | 'en' = 'en',
): string {
  const pref = findPrefecture(value);
  if (!pref) return value; // pass-through for unknown values
  return lang === 'ja' ? pref.nameJa : pref.name;
}

/**
 * Returns all prefectures grouped by region, useful for `<select>` optgroups
 * in the FNOL intake form.
 */
export function getPrefecturesByRegion(): Record<PrefectureRegion, Prefecture[]> {
  const result = {} as Record<PrefectureRegion, Prefecture[]>;
  for (const pref of PREFECTURES) {
    if (!result[pref.region]) {
      result[pref.region] = [];
    }
    result[pref.region].push(pref);
  }
  return result;
}

/**
 * Flat list of all prefecture options for `<select>` elements.
 * Sorted by JIS code (geographic order, north to south).
 */
export function getPrefectureOptions(): Array<{
  value: string;
  label: string;
  labelJa: string;
}> {
  return [...PREFECTURES].map((p) => ({
    value: p.nameJa, // stored value in DB is the kanji name
    label: `${p.name} (${p.nameJa})`,
    labelJa: p.nameJa,
  }));
}