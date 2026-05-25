#!/usr/bin/env node
/**
 * Verify regenerated Pass 2 — actually runs the artifacts.
 *
 * Steps:
 *   1. npx prisma generate (refresh client for any schema delta)
 *   2. npx tsc --noEmit       (does it even type-check?)
 *   3. npm test               (real behavioral signal)
 *   4. Write build_ok + test_pass_rate into pass2 manifest.json
 *
 * The judge picks these up and scores accordingly.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PASS2 = join(__dirname, "..", "sample-project", "pass2-orchestrated");
const MANIFEST = join(PASS2, "manifest.json");
const env = {
  ...process.env,
  DATABASE_URL: "file:./test.db",
  KEK_HEX: "0".repeat(64),
  JWT_SECRET: "test-jwt-secret-please-rotate",
  NODE_OPTIONS: "--localstorage-file=/tmp/_jest_ls.tmp",
};

function run(cmd, opts = {}) {
  try {
    const out = execSync(cmd, { cwd: PASS2, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? "") + "\n" + (e.stderr ?? ""), code: e.status };
  }
}

console.log("[1/4] prisma generate...");
const gen = run("npx prisma generate", { stdio: "ignore" });
console.log("      " + (gen.ok ? "OK" : "FAIL"));

console.log("[2/4] prisma db push (test.db)...");
const push = run("npx prisma db push --accept-data-loss --skip-generate", { stdio: "ignore" });
console.log("      " + (push.ok ? "OK" : "FAIL"));

console.log("[3/4] type-check (tsc --noEmit)...");
const tsc = run("npx tsc --noEmit");
console.log("      " + (tsc.ok ? "OK" : "FAIL"));
if (!tsc.ok) {
  // Count distinct error count for the manifest
  const errLines = tsc.out.split("\n").filter((l) => /error TS\d+:/.test(l));
  console.log(`      → ${errLines.length} TS errors, first 5:`);
  for (const l of errLines.slice(0, 5)) console.log("        " + l.trim());
}

console.log("[4/4] npm test (jest)...");
const jest = run("npx jest --config jest.config.cjs --runInBand --forceExit --json --outputFile=__test_results.json", { stdio: "ignore" });
let testPassRate = 0, testStats = { ok: 0, fail: 0, total: 0 };
if (existsSync(join(PASS2, "__test_results.json"))) {
  const r = JSON.parse(readFileSync(join(PASS2, "__test_results.json"), "utf-8"));
  testStats = {
    ok: r.numPassedTests ?? 0,
    fail: r.numFailedTests ?? 0,
    total: r.numTotalTests ?? 0,
    suite_ok: r.numPassedTestSuites ?? 0,
    suite_fail: r.numFailedTestSuites ?? 0,
  };
  testPassRate = testStats.total > 0 ? testStats.ok / testStats.total : 0;
  console.log(`      → ${testStats.ok}/${testStats.total} tests passed (${testStats.suite_ok}/${testStats.suite_ok + testStats.suite_fail} suites)`);
} else {
  console.log("      → could not parse test results; assuming all fail");
}

// Update manifest
const m = JSON.parse(readFileSync(MANIFEST, "utf-8"));
m.artifacts = {
  ...m.artifacts,
  build_ok: tsc.ok,
  ts_errors: tsc.ok ? 0 : (tsc.out.match(/error TS\d+:/g) ?? []).length,
  tests: testStats.total,
  tests_passed: testStats.ok,
  tests_failed: testStats.fail,
  test_pass_rate: +testPassRate.toFixed(3),
};
writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
console.log(`\nManifest updated: build_ok=${tsc.ok}, test_pass_rate=${(testPassRate*100).toFixed(0)}%`);
