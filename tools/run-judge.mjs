#!/usr/bin/env node
/**
 * LLM-as-judge runner. Scores every pass in passes.json on the rubric in
 * judge/rubric.md.
 *
 * Modes:
 *   - LIVE (if ANTHROPIC_API_KEY is set): real Opus scoring per pass artifacts.
 *   - HEURISTIC (fallback): rubric-based scoring from artifact inspection +
 *     recorded build_ok / test_pass_rate signals from each manifest.
 *
 * Writes `quality_scores` into every `<pass>/manifest.json` and a rolled-up
 * `judge/quality.json` with all per-pass scores and deltas.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RUBRIC = readFileSync(join(ROOT, "judge", "rubric.md"), "utf-8");

const passesConfig = JSON.parse(readFileSync(join(ROOT, "passes.json"), "utf-8"));
const passes = passesConfig.passes.map((p) => ({
  ...p,
  dir: join(ROOT, p.directory),
  manifest: existsSync(join(ROOT, p.directory, "manifest.json"))
    ? JSON.parse(readFileSync(join(ROOT, p.directory, "manifest.json"), "utf-8"))
    : null,
}));

const live = !!process.env.ANTHROPIC_API_KEY;

let scores = {};
if (live) {
  for (const p of passes) {
    scores[p.id] = p.manifest ? await scoreLive(p) : null;
  }
} else {
  for (const p of passes) {
    scores[p.id] = p.manifest ? scoreHeuristic(p) : null;
  }
}

// Persist per-pass into manifests
for (const p of passes) {
  if (!p.manifest || !scores[p.id]) continue;
  writeJsonInto(join(p.dir, "manifest.json"), { quality_scores: scores[p.id] });
}

// Roll-up + deltas (against pass 1 baseline)
const baseline = scores[passes[0].id];
writeFileSync(
  join(ROOT, "judge", "quality.json"),
  JSON.stringify(
    {
      mode: live ? "live-opus" : "heuristic-fallback",
      ts: new Date().toISOString(),
      passes: Object.fromEntries(
        passes.map((p) => [
          p.id,
          {
            scores: scores[p.id],
            delta_vs_pass1: scores[p.id] && baseline ? diff(baseline, scores[p.id]) : null,
          },
        ])
      ),
    },
    null,
    2
  )
);

console.log(`Judge complete (${live ? "LIVE" : "HEURISTIC"}):`);
for (const p of passes) {
  const s = scores[p.id];
  if (!s) { console.log(`  ${p.id}: (no manifest, skipped)`); continue; }
  console.log(`  ${p.id} (${p.shortLabel})`);
  for (const k of Object.keys(s)) {
    if (k.startsWith("_")) continue;
    console.log(`    ${k.padEnd(18)} ${s[k].toFixed(2)}`);
  }
}

// ---------------- helpers ----------------

function writeJsonInto(path, patch) {
  const m = JSON.parse(readFileSync(path, "utf-8"));
  Object.assign(m, patch);
  writeFileSync(path, JSON.stringify(m, null, 2));
}

function diff(a, b) {
  const out = {};
  for (const k of Object.keys(a)) {
    if (k.startsWith("_")) continue;
    out[k] = +(b[k] - a[k]).toFixed(2);
  }
  return out;
}

function scoreHeuristic(p) {
  const dir = p.dir;
  const has = (rel) => existsSync(join(dir, rel));
  const sizeOf = (rel) => has(rel) ? statSync(join(dir, rel)).size : 0;
  const fileCount = countFiles(join(dir, "src"));
  const a = p.manifest.artifacts ?? {};
  const testPassRate = typeof a.test_pass_rate === "number" && a.test_pass_rate >= 0 ? a.test_pass_rate : 1.0;
  const buildOk = a.build_ok !== false;

  const correctness = clamp(
    1.5 + 1.5 * (buildOk ? 1 : 0) + 1.0 * testPassRate + 0.5 * (fileCount > 20 ? 1 : 0)
  );
  const test_coverage = clamp(
    1.0 +
    0.5 * has("test/auth.e2e.spec.ts") +
    0.5 * has("test/employees.e2e.spec.ts") +
    0.5 * has("test/leave.e2e.spec.ts") +
    0.5 * (sizeOf("test/employees.e2e.spec.ts") > 2000) +
    2.0 * testPassRate
  );
  const security_posture = clamp(
    2.0 +
    0.4 * has("src/common/encryption.ts") +
    0.4 * has("src/common/jwt-auth.guard.ts") +
    0.4 * has("src/common/audit.interceptor.ts") +
    0.4 * has("security_review.md") +
    0.4 * (sizeOf("security_review.md") > 1000) +
    0.5 * (buildOk ? 1 : 0)
  );
  const documentation = clamp(
    2.5 +
    0.5 * has("README.md") +
    0.5 * has("docs/adr/001-encryption.md") +
    0.5 * has("docs/adr/002-audit-immutability.md") +
    0.5 * (sizeOf("README.md") > 1500)
  );
  const code_style = clamp(
    2.0 + 0.5 * has("tsconfig.json") + 0.5 * has("nest-cli.json") + 2.0 * (buildOk ? 1 : 0)
  );
  return {
    correctness, test_coverage, security_posture, documentation, code_style,
    _build_ok: buildOk,
    _test_pass_rate: testPassRate,
    _notes: `Heuristic — build_ok=${buildOk}, test_pass_rate=${(testPassRate * 100).toFixed(0)}%, files=${fileCount}.`,
  };
}

function clamp(n) { return Math.max(1, Math.min(5, +n.toFixed(2))); }

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else count++;
    }
  };
  walk(dir);
  return count;
}

async function scoreLive(p) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const sample = {
    requirements: safeRead(join(p.dir, "requirements.md")),
    design: safeRead(join(p.dir, "design.md")),
    employees_ctl: safeRead(join(p.dir, "src/employees/employees.controller.ts")),
    employees_svc: safeRead(join(p.dir, "src/employees/employees.service.ts")),
    auth_test: safeRead(join(p.dir, "test/auth.e2e.spec.ts")),
    employees_test: safeRead(join(p.dir, "test/employees.e2e.spec.ts")),
    security: safeRead(join(p.dir, "security_review.md")),
    readme: safeRead(join(p.dir, "README.md")),
  };
  const prompt = `You are a senior code reviewer scoring an AI-generated backend per a rubric. Score 1.0-5.0 on each dimension. Return JSON only.\n\n## Rubric\n${RUBRIC}\n\n## Pass label\n${p.label}\n\n## Sample artifacts\n${Object.entries(sample).map(([k, v]) => `### ${k}\n\`\`\`\n${v.slice(0, 4000)}\n\`\`\``).join("\n\n")}\n\n## Output\nReturn exactly: {"correctness":N,"test_coverage":N,"security_posture":N,"documentation":N,"code_style":N,"_notes":"..."}`;
  const resp = await client.messages.create({
    model: "claude-opus-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = resp.content.map((b) => ("text" in b ? b.text : "")).join("");
  try { return JSON.parse(text.match(/\{[\s\S]*\}/)[0]); }
  catch { return { correctness: 3, test_coverage: 3, security_posture: 3, documentation: 3, code_style: 3, _notes: "parse error" }; }
}

function safeRead(p) { try { return readFileSync(p, "utf-8"); } catch { return ""; } }
