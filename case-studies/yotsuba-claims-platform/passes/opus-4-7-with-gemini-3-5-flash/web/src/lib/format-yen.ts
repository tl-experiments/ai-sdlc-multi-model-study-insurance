/**
 * Formats a number as Japanese Yen (JPY).
 */
export interface FormatYenOptions {
  includeSymbol?: boolean;
  useKanji?: boolean;
  chunkLargeNumbers?: boolean;
  decimalPlaces?: number;
}

export function formatYen(value: number, options: FormatYenOptions = {}): string {
  const {
    includeSymbol = true,
    useKanji = false,
    chunkLargeNumbers = false,
    decimalPlaces = 0,
  } = options;

  if (typeof value !== 'number' || isNaN(value)) {
    return includeSymbol ? '¥0' : '0';
  }

  if (chunkLargeNumbers) {
    return formatYenInKanjiUnits(value, { includeSymbol, useKanji });
  }

  const formattedNumber = new Intl.NumberFormat('ja-JP', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(value);

  let result = formattedNumber;

  if (includeSymbol) {
    result = `¥${result}`;
  }

  if (useKanji) {
    result = `${result}円`;
  }

  return result;
}

function formatYenInKanjiUnits(
  value: number,
  options: { includeSymbol: boolean; useKanji: boolean }
): string {
  const { includeSymbol, useKanji } = options;
  const absValue = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (absValue === 0) {
    const prefix = includeSymbol ? '¥' : '';
    const suffix = useKanji ? '円' : '';
    return `${prefix}0${suffix}`;
  }

  const units = [
    { value: 1e12, label: '兆' },
    { value: 1e8, label: '億' },
    { value: 1e4, label: '万' },
  ];

  let remaining = absValue;
  const parts: string[] = [];

  for (const unit of units) {
    if (remaining >= unit.value) {
      const count = Math.floor(remaining / unit.value);
      remaining %= unit.value;
      parts.push(`${count}${unit.label}`);
    }
  }

  const remainder = Math.round(remaining);
  if (remainder > 0 || parts.length === 0) {
    parts.push(`${remainder}`);
  }

  const joined = parts.join('');
  const prefix = includeSymbol ? '¥' : '';
  const suffix = useKanji ? '円' : '';

  return `${sign}${prefix}${joined}${suffix}`;
}