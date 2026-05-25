#!/usr/bin/env node
/**
 * Parametric verifier. For a given pass:
 *   - prisma generate + db push to test.db
 *   - tsc --noEmit
 *   - npm test
 *   - write build_ok + test_pass_rate into <pass>/manifest.json
 *
 * Usage:
 *   node tools/verify.mjs --pass=pass2
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const passId = process.argv.find((a) => a.startsWith("--pass="))?.split("=")[1];
const studyId = process.argv.find((a) => a.startsWith("--study="))?.split("=")[1];
if (!passId) { console.error("usage: verify.mjs [--study=<id>] --pass=<id>"); process.exit(2); }

// New-style: studies.json + --study + --pass
// Old-style: passes.json + --pass alone (Phase 1 back-compat)
let PASS_DIR;
let passLabel = passId;
const studiesPath = join(ROOT, "studies.json");
if (studyId && existsSync(studiesPath)) {
  const cfg = JSON.parse(readFileSync(studiesPath, "utf-8"));
  const study = cfg.studies.find((s) => s.id === studyId);
  if (!study) { console.error(`study '${studyId}' not in studies.json`); process.exit(2); }
  const pass = study.passes.find((p) => p.id === passId || p.policy === passId);
  if (!pass) { console.error(`pass id '${passId}' not in study '${studyId}'`); process.exit(2); }
  PASS_DIR = join(ROOT, study.passes_root, pass.directory);
  passLabel = `${studyId}/${pass.policy || pass.id}`;
} else if (existsSync(join(ROOT, "passes.json"))) {
  const cfg = JSON.parse(readFileSync(join(ROOT, "passes.json"), "utf-8"));
  const pass = cfg.passes.find((p) => p.id === passId);
  if (!pass) { console.error(`pass id '${passId}' not in passes.json`); process.exit(2); }
  PASS_DIR = join(ROOT, pass.directory);
} else {
  console.error("Neither studies.json nor passes.json found at project root.");
  process.exit(2);
}
const MANIFEST = join(PASS_DIR, "manifest.json");
const env = {
  ...process.env,
  DATABASE_URL: "file:./test.db",
  KEK_HEX: "0".repeat(64),
  JWT_SECRET: "test-jwt-secret-please-rotate",
  NODE_OPTIONS: "--localstorage-file=/tmp/_jest_ls.tmp",
};

function run(cmd, opts = {}) {
  try {
    const out = execSync(cmd, { cwd: PASS_DIR, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? "") + "\n" + (e.stderr ?? ""), code: e.status };
  }
}

console.log(`Verifying ${passLabel} (${PASS_DIR.replace(ROOT + "/", "")})`);

console.log("[1/4] prisma generate...");
const gen = run("npx prisma generate", { stdio: "ignore" });
console.log("      " + (gen.ok ? "OK" : "FAIL"));

console.log("[2/4] prisma db push (test.db)...");
const push = run("npx prisma db push --accept-data-loss --skip-generate", { stdio: "ignore" });
console.log("      " + (push.ok ? "OK" : "FAIL"));

console.log("[3/4] type-check (tsc --noEmit)...");
const tsc = run("npx tsc --noEmit");
const tsErrors = tsc.ok ? 0 : (tsc.out.match(/error TS\d+:/g) ?? []).length;
console.log("      " + (tsc.ok ? "OK" : `FAIL (${tsErrors} errors)`));
if (!tsc.ok) {
  console.log("      first 5 errors:");
  tsc.out.split("\n").filter((l) => /error TS\d+:/.test(l)).slice(0, 5).forEach((l) => console.log("        " + l.trim()));
}

console.log("[4/4] npm test (jest)...");
const jest = run("npx jest --config jest.config.cjs --runInBand --forceExit --json --outputFile=__test_results.json", { stdio: "ignore" });
let testPassRate = 0, testStats = { ok: 0, fail: 0, total: 0, suite_ok: 0, suite_fail: 0 };
if (existsSync(join(PASS_DIR, "__test_results.json"))) {
  const r = JSON.parse(readFileSync(join(PASS_DIR, "__test_results.json"), "utf-8"));
  testStats = {
    ok: r.numPassedTests ?? 0, fail: r.numFailedTests ?? 0, total: r.numTotalTests ?? 0,
    suite_ok: r.numPassedTestSuites ?? 0, suite_fail: r.numFailedTestSuites ?? 0,
  };
  testPassRate = testStats.total > 0 ? testStats.ok / testStats.total : 0;
  console.log(`      → ${testStats.ok}/${testStats.total} tests passed (${testStats.suite_ok}/${testStats.suite_ok + testStats.suite_fail} suites)`);
}

// Update manifest with measured signals
if (existsSync(MANIFEST)) {
  const m = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  m.artifacts = {
    ...m.artifacts,
    build_ok: tsc.ok,
    ts_errors: tsErrors,
    tests: testStats.total,
    tests_passed: testStats.ok,
    tests_failed: testStats.fail,
    test_pass_rate: +testPassRate.toFixed(3),
  };
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  console.log(`\n${passLabel} manifest updated: build_ok=${tsc.ok}, test_pass_rate=${(testPassRate*100).toFixed(0)}%`);
} else {
  console.warn(`\nNo manifest at ${MANIFEST} — verifier results NOT persisted`);
}
