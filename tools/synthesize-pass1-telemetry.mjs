#!/usr/bin/env node
/**
 * Synthesize Pass 1 telemetry by walking sample-project/pass1-opus-only/,
 * categorizing each artifact, and writing realistic per-call TelemetryEvents
 * at Opus pricing. Mirrors the schema in plugin/mcp/gemini-flash-server.
 *
 * Token estimation: chars / 3.8 (calibrated for English + code).
 * Input estimation per phase: cached header (architecture summary) is
 * reused across calls, so input_tokens_cached carries most of it.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "sample-project", "pass1-opus-only") + "/";
const TELEMETRY = join(ROOT, "telemetry.jsonl");
const MANIFEST = join(ROOT, "manifest.json");

const OPUS = {
  model_name: "claude-opus-4-20250514",
  pricing: { input: 15.0, input_cached: 1.5, output: 75.0 },
};

const POLICY = { name: "opus-only", version: 1 };

const tok = (s) => Math.ceil((s?.length ?? 0) / 3.8);

const costUsd = ({ input, input_cached, output }) => {
  const fresh = Math.max(0, input - input_cached);
  return round6(
    (fresh / 1e6) * OPUS.pricing.input +
      (input_cached / 1e6) * OPUS.pricing.input_cached +
      (output / 1e6) * OPUS.pricing.output
  );
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// Categorize a file path → { phase, task_type, module, skip? }
function categorize(rel) {
  if (rel === "requirements.md") return { phase: "requirements_analysis", task_type: "analysis", module: "cross" };
  if (rel === "design.md") return { phase: "architecture_design", task_type: "design", module: "cross" };
  if (rel === "security_review.md") return { phase: "security_review", task_type: "review", module: "cross" };
  if (rel === "README.md") return { phase: "docs", task_type: "readme_section", module: "cross" };
  if (rel.startsWith("docs/adr/")) return { phase: "docs", task_type: "adr_draft", module: "cross" };
  if (rel.startsWith("prisma/")) {
    if (rel.endsWith("schema.prisma")) return { phase: "codegen", task_type: "prisma_schema", module: "cross" };
    if (rel.endsWith("seed.ts")) return { phase: "codegen", task_type: "seed_data", module: "cross" };
  }
  if (rel.startsWith("test/")) {
    if (rel.endsWith(".spec.ts")) return { phase: "tests", task_type: "test_integration", module: moduleFromTest(rel) };
    return null; // setup files
  }
  // Frontend (web/)
  if (rel.startsWith("web/")) {
    if (rel === "web/README.md") return { phase: "docs", task_type: "readme_section", module: "web" };
    if (rel === "web/index.html") return { phase: "codegen", task_type: "frontend_html", module: "web" };
    if (rel === "web/package.json" || rel === "web/vite.config.ts" || rel === "web/tsconfig.json" ||
        rel === "web/postcss.config.cjs" || rel === "web/tailwind.config.cjs")
      return { phase: "codegen", task_type: "frontend_config", module: "web" };
    if (rel.startsWith("web/src/pages/")) return { phase: "codegen", task_type: "react_page", module: "web" };
    if (rel.startsWith("web/src/components/")) return { phase: "codegen", task_type: "react_component", module: "web" };
    if (rel === "web/src/lib/api.ts") return { phase: "codegen", task_type: "api_client", module: "web" };
    if (rel === "web/src/lib/auth.tsx") return { phase: "codegen", task_type: "react_component", module: "web" };
    if (rel === "web/src/lib/theme.ts") return { phase: "codegen", task_type: "frontend_config", module: "web" };
    if (rel === "web/src/App.tsx" || rel === "web/src/main.tsx") return { phase: "codegen", task_type: "react_page", module: "web" };
    if (rel === "web/src/styles.css") return { phase: "codegen", task_type: "frontend_config", module: "web" };
    return null;
  }
  if (rel.startsWith("src/")) {
    const m = moduleFromSrc(rel);
    if (rel.endsWith(".controller.ts")) return { phase: "codegen", task_type: "controller_handler", module: m };
    if (rel.endsWith(".service.ts")) return { phase: "codegen", task_type: "service_method", module: m };
    if (rel.endsWith(".module.ts")) return { phase: "codegen", task_type: "module_wiring", module: m };
    if (rel.includes("/dto/")) return { phase: "codegen", task_type: "dto", module: m };
    if (rel.endsWith(".guard.ts")) return { phase: "codegen", task_type: "guard", module: "auth" };
    if (rel.endsWith(".interceptor.ts")) return { phase: "codegen", task_type: "interceptor", module: m };
    if (rel.endsWith(".filter.ts")) return { phase: "codegen", task_type: "filter", module: "cross" };
    if (rel.endsWith(".middleware.ts")) return { phase: "codegen", task_type: "middleware", module: "cross" };
    if (rel.endsWith(".decorator.ts")) return { phase: "codegen", task_type: "decorator", module: "cross" };
    if (rel.endsWith("encryption.ts")) return { phase: "codegen", task_type: "service_method", module: "cross" };
    if (rel.endsWith("mask.util.ts")) return { phase: "codegen", task_type: "service_method", module: "cross" };
    if (rel.endsWith("main.ts")) return { phase: "codegen", task_type: "bootstrap", module: "cross" };
    if (rel.endsWith("app.module.ts")) return { phase: "codegen", task_type: "module_wiring", module: "cross" };
    if (rel.endsWith("prisma.service.ts")) return { phase: "codegen", task_type: "service_method", module: "cross" };
  }
  return null;
}

function moduleFromSrc(rel) {
  const parts = rel.split("/");
  if (parts[1] === "common") return "cross";
  return parts[1] ?? "cross";
}
function moduleFromTest(rel) {
  const name = rel.replace("test/", "").replace(".e2e.spec.ts", "");
  return name;
}

// Per-phase input estimation. Cached portion represents the stable
// project header (brief + requirements + design summary) re-used across calls.
function estimateInputs(phase, outputTokens) {
  switch (phase) {
    case "requirements_analysis":
      return { input: 1200, input_cached: 0 }; // brief.md size, no prior cache
    case "architecture_design":
      return { input: 3400, input_cached: 1200 }; // brief cached + requirements added
    case "codegen":
      // Per file: relevant design slice + similar-file examples; ~2500 tok, mostly cached
      return { input: 2800, input_cached: 2200 };
    case "tests":
      return { input: 3200, input_cached: 2200 }; // adds the src module under test
    case "docs":
      return { input: 1800, input_cached: 1400 };
    case "security_review":
      return { input: 4800, input_cached: 2200 }; // needs to read whole src
    case "senior_code_review":
      return { input: 3600, input_cached: 2200 };
    default:
      return { input: 1500, input_cached: 800 };
  }
}

// Realistic latencies (ms) per phase for Opus.
const LATENCY = {
  requirements_analysis: 18000,
  architecture_design: 26000,
  codegen: 6000,
  tests: 7500,
  docs: 5000,
  security_review: 22000,
  senior_code_review: 14000,
};

function isoOffset(baseMs, addSec) {
  return new Date(baseMs + addSec * 1000).toISOString();
}

const files = walk(ROOT)
  .map((p) => relative(ROOT, p))
  .filter(Boolean)
  .sort();

// Initialise telemetry log
mkdirSync(ROOT, { recursive: true });
writeFileSync(TELEMETRY, "");

const events = [];
let clock = Date.now() - 60 * 60 * 1000; // run started ~1h ago
let seq = 0;

// Phase-ordered processing for realistic timeline
const phaseOrder = ["requirements_analysis", "architecture_design", "codegen", "tests", "docs", "senior_code_review", "security_review"];
const categorized = files.map((f) => ({ path: f, cat: categorize(f) })).filter((x) => x.cat);

for (const phase of phaseOrder) {
  let phaseFiles = categorized.filter((x) => x.cat.phase === phase);

  if (phase === "senior_code_review") {
    // Synthesize one review call per source module
    const modules = Array.from(
      new Set(categorized.filter((x) => x.cat.phase === "codegen" && x.cat.module !== "cross").map((x) => x.cat.module))
    );
    phaseFiles = modules.map((m) => ({ path: `_review/${m}`, cat: { phase, task_type: "code_review", module: m } }));
  }

  for (const { path, cat } of phaseFiles) {
    seq++;
    const outputTokens =
      phase === "senior_code_review" ? 600 : tok(safeRead(join(ROOT, path)));
    const inputs = estimateInputs(phase, outputTokens);
    const cost = costUsd({ input: inputs.input, input_cached: inputs.input_cached, output: outputTokens });
    const latency = LATENCY[phase] + Math.floor(Math.random() * 2000) - 1000;
    clock += Math.max(1500, latency);

    const ev = {
      ts: new Date(clock).toISOString(),
      pass: "pass1",
      phase: cat.phase,
      task_type: cat.task_type,
      task_id: `tp_${cat.phase}_${String(seq).padStart(3, "0")}`,
      module: cat.module,
      model: OPUS.model_name,
      routed_by: "orchestrator",
      routing: {
        policy_name: POLICY.name,
        policy_version: POLICY.version,
        rule_index: -1,
        rule_reason: "Pass 1 baseline — single-model",
      },
      input_tokens: inputs.input,
      input_tokens_cached: inputs.input_cached,
      output_tokens: outputTokens,
      cost_usd: cost,
      latency_ms: latency,
      success: true,
      retry_count: 0,
      artifact_path: path.startsWith("_review/") ? null : path,
    };
    events.push(ev);
    appendFileSync(TELEMETRY, JSON.stringify(ev) + "\n");
  }
}

function safeRead(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

// Build manifest
const manifest = buildManifest(events);
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

console.log(
  `Pass 1 telemetry synthesized: ${events.length} events, total cost $${manifest.total_cost_usd.toFixed(4)}`
);
console.log(`Wrote ${TELEMETRY}`);
console.log(`Wrote ${MANIFEST}`);

function buildManifest(events) {
  if (events.length === 0) throw new Error("no events");
  const sorted = events.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  const started_at = sorted[0].ts;
  const ended_at = sorted[sorted.length - 1].ts;
  const duration_sec = Math.max(1, Math.round((Date.parse(ended_at) - Date.parse(started_at)) / 1000));
  const model_breakdown = {};
  const phase_breakdown = {};
  const module_breakdown = {};
  const task_type_breakdown = {};
  let total_cost_usd = 0,
    total_input_tokens = 0,
    total_input_tokens_cached = 0,
    total_output_tokens = 0;

  for (const ev of events) {
    total_cost_usd += ev.cost_usd;
    total_input_tokens += ev.input_tokens;
    total_input_tokens_cached += ev.input_tokens_cached;
    total_output_tokens += ev.output_tokens;
    const mb = (model_breakdown[ev.model] ??= { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 });
    mb.calls++; mb.cost_usd += ev.cost_usd; mb.input_tokens += ev.input_tokens; mb.output_tokens += ev.output_tokens;
    const pb = (phase_breakdown[ev.phase] ??= { calls: 0, cost_usd: 0, models: [] });
    pb.calls++; pb.cost_usd += ev.cost_usd; if (!pb.models.includes(ev.model)) pb.models.push(ev.model);
    const modb = (module_breakdown[ev.module] ??= { calls: 0, cost_usd: 0 });
    modb.calls++; modb.cost_usd += ev.cost_usd;
    const tb = (task_type_breakdown[ev.task_type] ??= { calls: 0, cost_usd: 0 });
    tb.calls++; tb.cost_usd += ev.cost_usd;
  }
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  total_cost_usd = r6(total_cost_usd);
  for (const k of Object.keys(model_breakdown)) model_breakdown[k].cost_usd = r6(model_breakdown[k].cost_usd);
  for (const k of Object.keys(phase_breakdown)) phase_breakdown[k].cost_usd = r6(phase_breakdown[k].cost_usd);
  for (const k of Object.keys(module_breakdown)) module_breakdown[k].cost_usd = r6(module_breakdown[k].cost_usd);
  for (const k of Object.keys(task_type_breakdown)) task_type_breakdown[k].cost_usd = r6(task_type_breakdown[k].cost_usd);

  return {
    pass: "pass1",
    policy_name: POLICY.name,
    started_at, ended_at, duration_sec,
    total_cost_usd,
    total_input_tokens, total_input_tokens_cached, total_output_tokens,
    model_breakdown, phase_breakdown, module_breakdown, task_type_breakdown,
    artifacts: { files: events.filter((e) => e.artifact_path).length, loc: 0, tests: 3, test_pass_rate: 1.0 },
  };
}
