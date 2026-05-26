#!/usr/bin/env node
/**
 * Parametric verifier. For a given pass:
 *   - npm install (if node_modules missing)
 *   - prisma generate (schema-only, no DB connection required)
 *   - tsc --noEmit              ← build_ok signal
 *   - npm test (best-effort; failures don't change build_ok)
 *   - write build_ok + test_pass_rate into <pass>/manifest.json
 *
 * Track A note: Yotsuba briefs use PostgreSQL with testcontainers-style
 * e2e tests. We don't spin up a real postgres in the verifier — tests
 * are best-effort. The credible signal for "this code works" in Track A
 * is build_ok=true + LOC count. Test pass rate becomes meaningful once
 * Track B's CI grows a real database container.
 *
 * Usage:
 *   node tools/verify.mjs [--study=<id>] --pass=<id> [--limit=N]
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
  // Fake postgres URL — prisma generate parses it but never actually connects.
  // Real prisma db push / migrations would need a live Postgres (Track B).
  DATABASE_URL: "postgresql://verify:verify@localhost:5432/verify_db",
  KEK_HEX: "0".repeat(64),
  JWT_SECRET: "test-jwt-secret-please-rotate",
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

// [0] npm install if node_modules missing. --no-audit --no-fund for speed.
// Smaller models sometimes hallucinate non-existent version numbers (e.g.
// @nestjs/jwt@^12.0.1 when current is 10.x). On ETARGET failures, we
// loosen the offending package's version to `latest` and retry.
if (!existsSync(join(PASS_DIR, "node_modules"))) {
  console.log("[0/4] npm install (first run for this pass)...");
  const installResult = installWithFallback();
  if (!installResult.ok) {
    console.log("      FAIL — see output above");
    process.exit(1);
  }
  console.log(`      OK${installResult.loosenedPkgs?.length ? ` (loosened: ${installResult.loosenedPkgs.join(", ")})` : ""}`);
} else {
  console.log("[0/4] node_modules present — skipping npm install");
}

function installWithFallback() {
  const loosenedPkgs = [];
  const pkgPath = join(PASS_DIR, "package.json");
  if (!existsSync(pkgPath)) return { ok: false, out: "no package.json" };
  for (let attempt = 0; attempt < 8; attempt++) {
    const out = run("npm install --no-audit --no-fund --no-progress 2>&1");
    if (out.ok) return { ok: true, loosenedPkgs };
    // Try to parse a hallucinated version. npm error formats vary:
    //   "No matching version found for @nestjs/jwt@^12.0.1."
    //   "No matching version found for foo@^1.2.3 while resolving"
    const m = out.out.match(/No matching version found for (@?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?)@\S+?\./);
    if (!m) {
      // Different error class. Print the last 30 lines to help diagnose.
      console.log("      install failed; npm output tail:");
      out.out.split("\n").slice(-30).forEach((l) => console.log("        " + l));
      return out;
    }
    const name = m[1];
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const target = pkg.dependencies?.[name] !== undefined ? "dependencies"
                 : pkg.devDependencies?.[name] !== undefined ? "devDependencies"
                 : null;
    if (!target) {
      console.log(`      can't locate ${name} in package.json; giving up`);
      return out;
    }
    console.log(`      ↻ ${name}@${pkg[target][name]} → ${name}@latest (attempt ${attempt + 1})`);
    pkg[target][name] = "latest";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    loosenedPkgs.push(name);
  }
  return { ok: false, out: "too many retries; check package.json sanity manually" };
}

console.log("[1/4] prisma generate (schema-only)...");
const gen = run("npx prisma generate");
console.log("      " + (gen.ok ? "OK" : `FAIL`));
if (!gen.ok) {
  // Show just the prisma error line for triage; full output is in gen.out
  const firstErr = gen.out.split("\n").find((l) => /error|Error/.test(l));
  if (firstErr) console.log("        " + firstErr.trim().slice(0, 200));
}

console.log("[2/4] type-check (tsc --noEmit)...");
const tsc = run("npx tsc --noEmit");
const tsErrors = tsc.ok ? 0 : (tsc.out.match(/error TS\d+:/g) ?? []).length;
console.log("      " + (tsc.ok ? "OK" : `FAIL (${tsErrors} errors)`));
if (!tsc.ok) {
  console.log("      first 8 errors:");
  tsc.out.split("\n").filter((l) => /error TS\d+:/.test(l)).slice(0, 8).forEach((l) => console.log("        " + l.trim()));
}

console.log("[3/4] npm test (jest, best-effort — DB-touching tests will fail without postgres)...");
const jest = run("npx jest --config jest.config.cjs --runInBand --forceExit --json --outputFile=__test_results.json --passWithNoTests 2>&1", { stdio: "ignore" });
let testPassRate = 0, testStats = { ok: 0, fail: 0, total: 0, suite_ok: 0, suite_fail: 0 };
if (existsSync(join(PASS_DIR, "__test_results.json"))) {
  try {
    const r = JSON.parse(readFileSync(join(PASS_DIR, "__test_results.json"), "utf-8"));
    testStats = {
      ok: r.numPassedTests ?? 0, fail: r.numFailedTests ?? 0, total: r.numTotalTests ?? 0,
      suite_ok: r.numPassedTestSuites ?? 0, suite_fail: r.numFailedTestSuites ?? 0,
    };
    testPassRate = testStats.total > 0 ? testStats.ok / testStats.total : 0;
    console.log(`      → ${testStats.ok}/${testStats.total} tests passed (${testStats.suite_ok}/${testStats.suite_ok + testStats.suite_fail} suites)`);
  } catch {
    console.log("      → could not parse jest output");
  }
} else {
  console.log("      → jest produced no output (likely couldn't load test files)");
}

console.log("[4/4] artifact-correctness check (no envelope leaks)...");
// Sanity check: scan written files for residual JSON envelopes (`{"content": ...}`)
// that would indicate extractContent failed. If found, mark build_ok=false even
// if tsc didn't catch it — those files are corrupt regardless of compile status.
let envelopeLeaks = 0;
try {
  const out = execSync(
    `grep -l --include="*.ts" --include="*.tsx" --include="*.json" --include="*.prisma" -r '^{[[:space:]]*"content":' . | wc -l`,
    { cwd: PASS_DIR, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
  );
  envelopeLeaks = parseInt(out.trim(), 10) || 0;
} catch {}
console.log("      " + (envelopeLeaks === 0 ? "OK" : `FAIL — ${envelopeLeaks} files have JSON-envelope leakage`));

// build_ok signal: tsc passes AND no envelope leaks. prisma generate
// failure doesn't block build_ok (Track A doesn't require a live DB).
const buildOk = tsc.ok && envelopeLeaks === 0;

// Update manifest with measured signals
if (existsSync(MANIFEST)) {
  const m = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  m.artifacts = {
    ...m.artifacts,
    build_ok: buildOk,
    ts_errors: tsErrors,
    envelope_leaks: envelopeLeaks,
    prisma_generate_ok: gen.ok,
    tests: testStats.total,
    tests_passed: testStats.ok,
    tests_failed: testStats.fail,
    test_pass_rate: +testPassRate.toFixed(3),
  };
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
  console.log(`\n${passLabel} manifest updated: build_ok=${buildOk}, ts_errors=${tsErrors}, envelope_leaks=${envelopeLeaks}, tests=${testStats.ok}/${testStats.total}`);
} else {
  console.warn(`\nNo manifest at ${MANIFEST} — verifier results NOT persisted`);
}
