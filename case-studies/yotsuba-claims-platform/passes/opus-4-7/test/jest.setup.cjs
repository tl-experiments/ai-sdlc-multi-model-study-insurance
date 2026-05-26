/**
 * Global Jest setup for the Yotsuba Insurance Claims Platform backend.
 *
 * This file is wired in via `setupFiles` (env shimming, runs before the test
 * framework is installed in the runtime) and `setupFilesAfterEach` style
 * hooks where appropriate. It is intentionally authored as CommonJS so that
 * Jest can load it without a TS transform step — keeping startup fast and
 * avoiding a chicken-and-egg with ts-jest configuration.
 *
 * Responsibilities:
 *  1. Pin NODE_ENV to 'test' so config-dependent modules (logger level,
 *     throttler, etc.) pick the test profile.
 *  2. Provide deterministic, non-secret defaults for every env var the app
 *     reads at bootstrap. Real secrets must never live in the repo; these
 *     are test-only fixtures.
 *  3. Point DATABASE_URL at a local Postgres test database. CI is expected
 *     to override this via the environment; the default below matches the
 *     docker-compose / local-dev convention documented in the README.
 *  4. Silence Pino in test runs unless the developer explicitly opts in
 *     with LOG_LEVEL, so Jest output stays readable.
 *  5. Stabilise time-zone behaviour — Japanese date handling is part of the
 *     domain (loss_date windows, JFSA daily flush), and a drifting TZ on a
 *     developer laptop must not flip test outcomes.
 */

'use strict';

// ─── 1. Environment profile ──────────────────────────────────────────────
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// ─── 2. Deterministic test defaults ──────────────────────────────────────
// JWT — fixed secret so tokens minted in one test can be verified in another
// within the same run. Never reuse this value outside tests.
process.env.JWT_SECRET =
  process.env.JWT_SECRET ||
  'test-only-jwt-secret-do-not-use-in-production-0123456789abcdef';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

// AES-256-GCM key-encryption-key for the APPI special-care PII envelope.
// Must be 32 bytes when base64-decoded. The literal below decodes to
// exactly 32 bytes of 0x00..0x1f — fine for tests, catastrophic for prod.
process.env.ENCRYPTION_KEK_BASE64 =
  process.env.ENCRYPTION_KEK_BASE64 ||
  'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

// APPI consent version surfaced at FNOL intake.
process.env.APPI_CONSENT_VERSION =
  process.env.APPI_CONSENT_VERSION || 'appi-2024-01';

// JFSA threshold for the regulator-notification emitter (¥100,000,000).
process.env.JFSA_RESERVE_THRESHOLD_YEN =
  process.env.JFSA_RESERVE_THRESHOLD_YEN || '100000000';

// ─── 3. Database ─────────────────────────────────────────────────────────
// A real Postgres instance is required; tests exercise migrations + Prisma.
// CI overrides this with the ephemeral container URL.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/yotsuba_claims_test?schema=public';

// ─── 4. Logging ──────────────────────────────────────────────────────────
// Pino is noisy during tests; default to `silent` unless the developer
// explicitly asks for logs by exporting LOG_LEVEL.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

// ─── 5. Time zone ────────────────────────────────────────────────────────
// Domain logic deals in Japanese dates (loss_date / policy effective
// windows). Pin to Asia/Tokyo so behaviour is identical on every machine.
process.env.TZ = process.env.TZ || 'Asia/Tokyo';

// ─── 6. Throttler / rate-limit knobs ─────────────────────────────────────
// Phase 1 enforces 5 req/min on /auth/login. Tests need a deterministic
// override path; modules read these if present.
process.env.RATE_LIMIT_LOGIN_TTL_SEC =
  process.env.RATE_LIMIT_LOGIN_TTL_SEC || '60';
process.env.RATE_LIMIT_LOGIN_MAX =
  process.env.RATE_LIMIT_LOGIN_MAX || '5';

// ─── 7. Unhandled-rejection visibility ───────────────────────────────────
// Jest will swallow some async failures silently; surface them so the suite
// fails loud rather than hanging.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[jest.setup] unhandledRejection:', reason);
  throw reason instanceof Error ? reason : new Error(String(reason));
});