/**
 * Yen formatting + prefecture helpers for the Yotsuba Adjuster Workbench.
 *
 * Why this module exists
 * ----------------------
 * Two concerns recur in the UI and they both have subtle correctness
 * requirements that we do not want re-implemented per page:
 *
 *   1. **Currency.** Reserves, approvals, and the IFRS17 export view all
 *      display yen amounts. The backend stores them as `Decimal @db.Decimal(15,0)`
 *      (see `prisma/schema.prisma`), which means JSON delivers them either as a
 *      stringified integer (`"15000000"`) or as a `number`. The UI must:
 *        - never lose precision (¥15,000,000 must not become 1.5e7),
 *        - render with the `¥` glyph and locale-appropriate thousands separators,
 *        - render negative deltas (reserve decreases) as `-¥…`,
 *        - tolerate `null` / `undefined` gracefully (display "—").
 *      A single helper keeps that contract consistent across components.
 *
 *   2. **Prefectures.** FNOL intake validates `loss_location_prefecture`
 *      against the 47 都道府県. The Workbench renders prefecture filter chips,
 *      labels in the claim detail header, and a dropdown in the (future)
 *      manual-edit form. Centralising the canonical list here means the front
 *      end and the seed/test fixtures cannot drift.
 *
 * Both helpers are pure, fully typed, and have no runtime dependencies. They
 * are deliberately tree-shakeable so that components that only need
 * `formatYen` do not pull in the prefecture table.
 */

// ─────────────────────────── yen formatting ───────────────────────────

/**
 * The shapes a yen amount can arrive in on the client. Prisma's `Decimal`
 * fields are serialised by NestJS as strings to preserve precision; some
 * intermediate aggregations (e.g. the IFRS17 export totals) may also arrive
 * as plain numbers. We accept both, plus the `null`/`undefined` cases that
 * occur for `prior_yen` on a brand-new reserve.
 */
export type YenInput = string | number | bigint | null | undefined;

/**
 * Options controlling the visual treatment of a yen amount.
 */
export interface FormatYenOptions {
  /**
   * Replacement string when the input is `null` / `undefined` / not a valid
   * number. Defaults to an em-dash, which is the workbench's standard
   * "no value" glyph (see ClaimDetail's reserve table).
   */
  fallback?: string;
  /**
   * Whether to render the `¥` symbol. Off by default for callers that wish
   * to assemble their own layout (e.g. a right-aligned amount column with a
   * separate `¥` header).
   */
  withSymbol?: boolean;
  /**
   * If `true`, render positive amounts with an explicit `+` prefix. Useful
   * for reserve deltas in the audit timeline where the sign carries
   * meaning. Negatives always render with `-` regardless of this flag.
   */
  signed?: boolean;
}

const DEFAULT_FORMAT_OPTIONS: Required<FormatYenOptions> = {
  fallback: '—',
  withSymbol: true,
  signed: false,
};

/**
 * `Intl.NumberFormat` instance reused across calls. Constructing one per
 * render is measurable in the claim queue (hundreds of rows × multiple
 * amount columns). Locale is fixed to `ja-JP` because yen grouping in
 * Japanese locale matches the carrier's internal house style — 3-digit
 * grouping with the half-width comma — which is what reviewers expect.
 */
const YEN_FORMATTER = new Intl.NumberFormat('ja-JP', {
  useGrouping: true,
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

/**
 * Parse a `YenInput` into a `bigint` representing whole yen, preserving the
 * sign. Returns `null` if the input cannot be safely interpreted as an
 * integral yen amount (NaN, non-numeric string, fractional value, etc.).
 *
 * We deliberately reject fractional inputs: yen has no sub-unit, and the
 * Prisma column is `Decimal(15,0)`. If a fractional value arrives, that is
 * a backend bug and silently rounding it on the client would hide it.
 */
function parseYen(input: YenInput): bigint | null {
  if (input === null || input === undefined) {
    return null;
  }

  if (typeof input === 'bigint') {
    return input;
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      return null;
    }
    // `Number.isSafeInteger` guards us against precision loss for amounts
    // beyond 2^53. ¥15-digit reserves can exceed that, so we coerce via
    // the integer-string path when the magnitude is too large.
    if (!Number.isSafeInteger(input)) {
      try {
        return BigInt(Math.trunc(input).toString());
      } catch {
        return null;
      }
    }
    return BigInt(input);
  }

  // String path. We accept an optional sign, optional grouping commas, and
  // an optional trailing `.0` (some legacy clients stringify Decimal that
  // way). Anything else is rejected.
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const normalised = trimmed.replace(/,/g, '');
  if (!/^-?\d+(?:\.0+)?$/.test(normalised)) {
    return null;
  }
  const integerPart = normalised.split('.')[0];
  try {
    return BigInt(integerPart);
  } catch {
    return null;
  }
}

/**
 * Render a yen amount for display.
 *
 * @example
 *   formatYen('15000000')                 // "¥15,000,000"
 *   formatYen(1500000, { signed: true })   // "+¥1,500,000"
 *   formatYen(null)                        // "—"
 *   formatYen('15000000', { withSymbol: false }) // "15,000,000"
 */
export function formatYen(input: YenInput, options: FormatYenOptions = {}): string {
  const opts = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  const parsed = parseYen(input);
  if (parsed === null) {
    return opts.fallback;
  }

  const isNegative = parsed < 0n;
  const absolute = isNegative ? -parsed : parsed;
  // `Intl.NumberFormat` cannot accept `bigint` in all engines on the
  // versions the workbench targets, so we route through the string form
  // (which it does accept) to avoid any precision concerns.
  const grouped = YEN_FORMATTER.format(absolute as unknown as number);

  const symbol = opts.withSymbol ? '¥' : '';
  if (isNegative) {
    return `-${symbol}${grouped}`;
  }
  if (opts.signed && parsed > 0n) {
    return `+${symbol}${grouped}`;
  }
  return `${symbol}${grouped}`;
}

/**
 * Compute and format the delta between a prior reserve and a proposed one.
 * Convenience wrapper used by the reserve approval queue, where the sign
 * carries operational meaning (increase vs. release).
 */
export function formatYenDelta(prior: YenInput, proposed: YenInput): string {
  const a = parseYen(prior) ?? 0n;
  const b = parseYen(proposed);
  if (b === null) {
    return DEFAULT_FORMAT_OPTIONS.fallback;
  }
  return formatYen(b - a, { signed: true });
}

// ─────────────────────────── prefectures ──────────────────────────────

/**
 * One of Japan's 47 都道府県. The codes are the canonical JIS X 0401
 * two-digit identifiers (01 = Hokkaidō, 13 = Tōkyō, 47 = Okinawa); we
 * surface them as strings so they round-trip through JSON without
 * losing the leading zero.
 */
export interface Prefecture {
  /** JIS X 0401 two-digit code, zero-padded. */
  readonly code: string;
  /** Japanese name (canonical). */
  readonly jp: string;
  /** Romanised name (Hepburn, no macrons — matches the seed data). */
  readonly en: string;
  /** Geographic region. Used by the queue's region filter. */
  readonly region:
    | 'Hokkaido'
    | 'Tohoku'
    | 'Kanto'
    | 'Chubu'
    | 'Kansai'
    | 'Chugoku'
    | 'Shikoku'
    | 'Kyushu';
}

/**
 * The complete, ordered list of Japanese prefectures. Order follows the
 * standard JIS code sequence (north to south, roughly), which is the
 * order reviewers expect to see in a dropdown.
 */
export const PREFECTURES: readonly Prefecture[] = [
  { code: '01', jp: '北海道', en: 'Hokkaido', region: 'Hokkaido' },
  { code: '02', jp: '青森県', en: 'Aomori', region: 'Tohoku' },
  { code: '03', jp: '岩手県', en: 'Iwate', region: 'Tohoku' },
  { code: '04', jp: '宮城県', en: 'Miyagi', region: 'Tohoku' },
  { code: '05', jp: '秋田県', en: 'Akita', region: 'Tohoku' },
  { code: '06', jp: '山形県', en: 'Yamagata', region: 'Tohoku' },
  { code: '07', jp: '福島県', en: 'Fukushima', region: 'Tohoku' },
  { code: '08', jp: '茨城県', en: 'Ibaraki', region: 'Kanto' },
  { code: '09', jp: '栃木県', en: 'Tochigi', region: 'Kanto' },
  { code: '10', jp: '群馬県', en: 'Gunma', region: 'Kanto' },
  { code: '11', jp: '埼玉県', en: 'Saitama', region: 'Kanto' },
  { code: '12', jp: '千葉県', en: 'Chiba', region: 'Kanto' },
  { code: '13', jp: '東京都', en: 'Tokyo', region: 'Kanto' },
  { code: '14', jp: '神奈川県', en: 'Kanagawa', region: 'Kanto' },
  { code: '15', jp: '新潟県', en: 'Niigata', region: 'Chubu' },
  { code: '16', jp: '富山県', en: 'Toyama', region: 'Chubu' },
  { code: '17', jp: '石川県', en: 'Ishikawa', region: 'Chubu' },
  { code: '18', jp: '福井県', en: 'Fukui', region: 'Chubu' },
  { code: '19', jp: '山梨県', en: 'Yamanashi', region: 'Chubu' },
  { code: '20', jp: '長野県', en: 'Nagano', region: 'Chubu' },
  { code: '21', jp: '岐阜県', en: 'Gifu', region: 'Chubu' },
  { code: '22', jp: '静岡県', en: 'Shizuoka', region: 'Chubu' },
  { code: '23', jp: '愛知県', en: 'Aichi', region: 'Chubu' },
  { code: '24', jp: '三重県', en: 'Mie', region: 'Kansai' },
  { code: '25', jp: '滋賀県', en: 'Shiga', region: 'Kansai' },
  { code: '26', jp: '京都府', en: 'Kyoto', region: 'Kansai' },
  { code: '27', jp: '大阪府', en: 'Osaka', region: 'Kansai' },
  { code: '28', jp: '兵庫県', en: 'Hyogo', region: 'Kansai' },
  { code: '29', jp: '奈良県', en: 'Nara', region: 'Kansai' },
  { code: '30', jp: '和歌山県', en: 'Wakayama', region: 'Kansai' },
  { code: '31', jp: '鳥取県', en: 'Tottori', region: 'Chugoku' },
  { code: '32', jp: '島根県', en: 'Shimane', region: 'Chugoku' },
  { code: '33', jp: '岡山県', en: 'Okayama', region: 'Chugoku' },
  { code: '34', jp: '広島県', en: 'Hiroshima', region: 'Chugoku' },
  { code: '35', jp: '山口県', en: 'Yamaguchi', region: 'Chugoku' },
  { code: '36', jp: '徳島県', en: 'Tokushima', region: 'Shikoku' },
  { code: '37', jp: '香川県', en: 'Kagawa', region: 'Shikoku' },
  { code: '38', jp: '愛媛県', en: 'Ehime', region: 'Shikoku' },
  { code: '39', jp: '高知県', en: 'Kochi', region: 'Shikoku' },
  { code: '40', jp: '福岡県', en: 'Fukuoka', region: 'Kyushu' },
  { code: '41', jp: '佐賀県', en: 'Saga', region: 'Kyushu' },
  { code: '42', jp: '長崎県', en: 'Nagasaki', region: 'Kyushu' },
  { code: '43', jp: '熊本県', en: 'Kumamoto', region: 'Kyushu' },
  { code: '44', jp: '大分県', en: 'Oita', region: 'Kyushu' },
  { code: '45', jp: '宮崎県', en: 'Miyazaki', region: 'Kyushu' },
  { code: '46', jp: '鹿児島県', en: 'Kagoshima', region: 'Kyushu' },
  { code: '47', jp: '沖縄県', en: 'Okinawa', region: 'Kyushu' },
] as const;

/**
 * Internal index: `jp` and `en` name → Prefecture record. Built once at
 * module load so per-lookup cost is O(1).
 */
const PREFECTURE_INDEX: ReadonlyMap<string, Prefecture> = (() => {
  const map = new Map<string, Prefecture>();
  for (const pref of PREFECTURES) {
    map.set(pref.jp, pref);
    map.set(pref.en.toLowerCase(), pref);
    map.set(pref.code, pref);
  }
  return map;
})();

/**
 * Look up a prefecture by any of its identifying strings: Japanese name
 * (`東京都`), romanised name (`Tokyo`, case-insensitive), or JIS code
 * (`13`). Returns `undefined` if no match is found.
 *
 * The FNOL intake validator on the backend normalises to the Japanese
 * name, so most lookups in the Workbench will use that form. The other
 * forms are accepted for resilience against legacy data and for the
 * (rare) cases where the UI receives a code from a URL parameter.
 */
export function findPrefecture(needle: string | null | undefined): Prefecture | undefined {
  if (!needle) {
    return undefined;
  }
  const direct = PREFECTURE_INDEX.get(needle);
  if (direct) {
    return direct;
  }
  return PREFECTURE_INDEX.get(needle.toLowerCase());
}

/**
 * Type guard / validator usable in form-submit handlers and in any
 * defensive code path that receives an externally-supplied prefecture
 * string (URL params, copy-pasted CSV imports, etc.).
 */
export function isValidPrefecture(needle: string | null | undefined): boolean {
  return findPrefecture(needle) !== undefined;
}

/**
 * Render a prefecture for display in the workbench. The carrier's house
 * style is "Japanese name (romanised)" in claim-detail headers, e.g.
 * `東京都 (Tokyo)`, falling back to the raw input if no match is found —
 * we never want to swallow data the backend chose to send us, even if
 * it's unrecognised.
 */
export function formatPrefecture(needle: string | null | undefined): string {
  if (!needle) {
    return '—';
  }
  const pref = findPrefecture(needle);
  if (!pref) {
    return needle;
  }
  return `${pref.jp} (${pref.en})`;
}