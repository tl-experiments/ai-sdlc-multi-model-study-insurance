// jest.setup.cjs
// Global Jest setup for Yotsuba Claims Processing Platform
// Runs once before all test suites

const dotenv = require('dotenv');
const path = require('path');

// Load .env.test if it exists, otherwise .env
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
const envPath = path.resolve(process.cwd(), envFile);

try {
  dotenv.config({ path: envPath });
} catch (err) {
  // .env file may not exist in all environments; that's OK
}

// Ensure test database URL is set
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable is not set. ' +
    'Please configure .env or .env.test with a valid PostgreSQL connection string.'
  );
}

// Set NODE_ENV to test if not already set
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

// Suppress console logs during tests unless DEBUG is set
if (!process.env.DEBUG) {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    // Keep error and error-like output for debugging test failures
    error: console.error,
  };
}

// Set a reasonable test timeout (30s is already in jest.config.cjs, but can be overridden per test)
jest.setTimeout(30000);

// Global test utilities
global.testUtils = {
  /**
   * Generate a valid Japanese postal code (7 digits)
   */
  generatePostalCode: () => {
    const area = String(Math.floor(Math.random() * 100)).padStart(2, '0');
    const block = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    return `${area}${block}`;
  },

  /**
   * Generate a valid policy number (e.g., YTB-2024-001234)
   */
  generatePolicyNumber: () => {
    const year = new Date().getFullYear();
    const seq = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    return `YTB-${year}-${seq}`;
  },

  /**
   * Generate a valid Japanese government ID (12 digits, format: YYYYMMDDXXXX)
   */
  generateGovernmentId: () => {
    const year = String(Math.floor(Math.random() * 100) + 1950).slice(-2);
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
    const seq = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    return `${year}${month}${day}${seq}`;
  },

  /**
   * List of valid Japanese prefectures (都道府県)
   */
  validPrefectures: [
    '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
    '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
    '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
    '岐阜県', '静岡県', '愛知県', '三重県',
    '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
    '鳥取県', '島根県', '岡山県', '広島県', '山口県',
    '徳島県', '香川県', '愛媛県', '高知県',
    '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県',
    '沖縄県',
  ],

  /**
   * Get a random valid prefecture
   */
  getRandomPrefecture: function () {
    return this.validPrefectures[
      Math.floor(Math.random() * this.validPrefectures.length)
    ];
  },

  /**
   * Validate a Japanese postal code format
   */
  isValidPostalCode: (code: string): boolean => {
    return /^\d{7}$/.test(code);
  },

  /**
   * Validate a Japanese prefecture
   */
  isValidPrefecture: function (pref: string): boolean {
    return this.validPrefectures.includes(pref);
  },
};

// Declare global testUtils for TypeScript
declare global {
  var testUtils: {
    generatePostalCode: () => string;
    generatePolicyNumber: () => string;
    generateGovernmentId: () => string;
    validPrefectures: string[];
    getRandomPrefecture: () => string;
    isValidPostalCode: (code: string) => boolean;
    isValidPrefecture: (pref: string) => boolean;
  };
}

module.exports = {};