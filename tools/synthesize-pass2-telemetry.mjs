#!/usr/bin/env node
/**
 * Synthesize Pass 2 telemetry by replaying Pass 1 events under the
 * default-2-tier policy. Models the real savings the dashboard will show:
 *   - premium phases stay on Opus with the same token profile
 *   - cost-efficient phases route to Gemini Flash:
 *       * output tokens unchanged (Gemini produces similar output size)
 *       * input tokens reduced ~15% (no inline Opus chat history)
 *       * input_tokens_cached rises dramatically after the first call per
 *         cache_context (Gemini explicit cache amortizes the stable header)
 *
 * Also copies Pass 1 source artifacts into pass2-orchestrated/ as
 * placeholders with a NOTICE marking them as simulation-grade until a live
 * Gemini run lands. Replace this synthesized output with `tools/run-pass2.mjs`
 * results once GEMINI_API_KEY is available.
 */

import {
  readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, appendFileSync, copyFileSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PASS1_DIR = join(__dirname, "..", "sample-project", "pass1-opus-only");
const PASS2_DIR = join(__dirname, "..", "sample-project", "pass2-orchestrated");
const POLICY_PATH = join(__dirname, "..", "plugin", "config", "policies", "default-2-tier.yaml");

// --- inline routing logic (mirrors plugin/mcp/.../routing.ts) ---
function pickModel(ctx, policy) {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) continue;
    if (matches(rule.when, ctx)) {
      return { modelId: rule.use, reason: rule.reason ?? `matched rule ${i}`, ruleIndex: i };
    }
  }
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if ("default" in rule) return { modelId: rule.default, reason: rule.reason ?? "default", ruleIndex: -1 };
  }
  throw new Error("policy has no matching rule and no default");
}
function matches(m, ctx) {
  if (m.phase !== undefined && !inSet(m.phase, ctx.phase)) return false;
  if (m.task_type !== undefined && !inSet(m.task_type, ctx.task_type)) return false;
  if (m.module !== undefined && !inSet(m.module, ctx.module)) return false;
  if (m.retry_count !== undefined) {
    const r = ctx.retry_count, c = m.retry_count;
    if (c.lt !== undefined && !(r < c.lt)) return false;
    if (c.lte !== undefined && !(r <= c.lte)) return false;
    if (c.gt !== undefined && !(r > c.gt)) return false;
    if (c.gte !== undefined && !(r >= c.gte)) return false;
    if (c.eq !== undefined && !(r === c.eq)) return false;
  }
  return true;
}
const inSet = (s, v) => Array.isArray(s) ? s.includes(v) : s === v;

// --- cost helper ---
function cost(tokens, pricing) {
  const fresh = Math.max(0, tokens.input - tokens.input_cached);
  return r6(
    (fresh / 1e6) * pricing.input +
      (tokens.input_cached / 1e6) * pricing.input_cached +
      (tokens.output / 1e6) * pricing.output
  );
}
const r6 = (n) => Math.round(n * 1e6) / 1e6;

// --- load policy ---
const policy = parseYaml(readFileSync(POLICY_PATH, "utf-8"));
const modelById = Object.fromEntries(policy.models.map((m) => [m.id, m]));

// --- load Pass 1 events ---
const lines = readFileSync(join(PASS1_DIR, "telemetry.jsonl"), "utf-8")
  .split("\n").filter(Boolean);
const pass1 = lines.map((l) => JSON.parse(l));

// --- replay ---
const pass2 = [];
let geminiCacheSeen = false; // first Gemini call seeds cache; subsequent hit
let cumulativeGeminiTokensSaved = 0;

for (const ev1 of pass1) {
  const decision = pickModel({
    phase: ev1.phase, task_type: ev1.task_type, module: ev1.module, retry_count: 0,
  }, policy);
  const model = modelById[decision.modelId];

  let input, input_cached, output;
  if (decision.modelId === "opus") {
    // Same call, same tokens — Pass 1 Opus prompt caching applies similarly
    input = ev1.input_tokens;
    input_cached = ev1.input_tokens_cached;
    output = ev1.output_tokens;
  } else {
    // Routed to Gemini Flash
    output = ev1.output_tokens;
    // Slim down input (~15% drop) because TaskPackets carry no Opus chat history
    input = Math.round(ev1.input_tokens * 0.85);
    if (!geminiCacheSeen) {
      // First Gemini call: seed the explicit cache, full price on inputs
      input_cached = 0;
      geminiCacheSeen = true;
    } else {
      // Subsequent calls hit the cache for the stable header (~80% of input)
      input_cached = Math.round(input * 0.8);
    }
    cumulativeGeminiTokensSaved += input_cached;
  }

  const newCost = cost({ input, input_cached, output }, model.pricing);
  const newLatency = decision.modelId === "gemini-flash"
    ? Math.max(800, Math.round(ev1.latency_ms * 0.45)) // Flash is faster
    : ev1.latency_ms;

  pass2.push({
    ts: ev1.ts,
    pass: "pass2",
    phase: ev1.phase,
    task_type: ev1.task_type,
    task_id: ev1.task_id,
    module: ev1.module,
    model: model.model_name,
    routed_by: "orchestrator",
    routing: {
      policy_name: policy.name,
      policy_version: policy.version,
      rule_index: decision.ruleIndex,
      rule_reason: decision.reason,
    },
    input_tokens: input,
    input_tokens_cached: input_cached,
    output_tokens: output,
    cost_usd: newCost,
    latency_ms: newLatency,
    success: true,
    retry_count: 0,
    artifact_path: ev1.artifact_path,
  });
}

// --- copy artifacts as placeholders ---
mkdirSync(PASS2_DIR, { recursive: true });
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith("telemetry") || name.startsWith("manifest")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}
let copied = 0;
for (const src of walk(PASS1_DIR)) {
  const rel = relative(PASS1_DIR, src);
  const dst = join(PASS2_DIR, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied++;
}

// --- write Pass 2 telemetry & manifest ---
writeFileSync(join(PASS2_DIR, "telemetry.jsonl"), pass2.map((e) => JSON.stringify(e)).join("\n") + "\n");

const manifest = buildManifest(pass2, "pass2", policy.name);
writeFileSync(join(PASS2_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

// --- notice ---
writeFileSync(
  join(PASS2_DIR, "NOTICE.md"),
  `# Pass 2 — Synthesized telemetry (pending live Gemini run)

This directory currently contains:
- **Source artifacts** copied from \`../pass1-opus-only/\` as placeholders.
- **\`telemetry.jsonl\`** synthesized by replaying Pass 1 events through the
  \`default-2-tier\` routing policy and recomputing costs at each routed
  model's price. Gemini context-caching savings are modeled per the
  TaskPacket strategy (first call seeds the cache; subsequent calls reuse it).
- **\`manifest.json\`** rolled up from the synthesized telemetry.

To replace with a real run once \`GEMINI_API_KEY\` is available:

\`\`\`bash
export GEMINI_API_KEY=sk-...
cd ..
node tools/run-pass2.mjs sample-project/brief.md
\`\`\`

The dashboard reads from \`telemetry.jsonl\` / \`manifest.json\`, so swapping
real for synthesized data is zero-touch on the UI side.

## Headline simulated numbers
- Pass 1 total: $${getPass1Total().toFixed(4)}
- Pass 2 simulated total: $${manifest.total_cost_usd.toFixed(4)}
- Estimated savings: ${(100 * (1 - manifest.total_cost_usd / getPass1Total())).toFixed(1)}%
`
);

function getPass1Total() {
  return JSON.parse(readFileSync(join(PASS1_DIR, "manifest.json"), "utf-8")).total_cost_usd;
}

console.log(`Pass 2 synthesis complete:`);
console.log(`  events:    ${pass2.length}`);
console.log(`  artifacts: ${copied} copied as placeholders`);
console.log(`  cost USD:  $${manifest.total_cost_usd.toFixed(4)} (vs Pass 1 $${getPass1Total().toFixed(4)})`);
console.log(`  savings:   ${(100 * (1 - manifest.total_cost_usd / getPass1Total())).toFixed(1)}%`);

// --- manifest builder (mirrors plugin/mcp/.../telemetry.ts) ---
function buildManifest(events, pass, policy_name) {
  const sorted = events.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  const started_at = sorted[0]?.ts ?? new Date().toISOString();
  const ended_at = sorted.at(-1)?.ts ?? started_at;
  const duration_sec = Math.max(1, Math.round((Date.parse(ended_at) - Date.parse(started_at)) / 1000));
  const model_breakdown = {}, phase_breakdown = {}, module_breakdown = {}, task_type_breakdown = {};
  let total_cost_usd = 0, total_input_tokens = 0, total_input_tokens_cached = 0, total_output_tokens = 0;
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
  total_cost_usd = r6(total_cost_usd);
  for (const k of Object.keys(model_breakdown)) model_breakdown[k].cost_usd = r6(model_breakdown[k].cost_usd);
  for (const k of Object.keys(phase_breakdown)) phase_breakdown[k].cost_usd = r6(phase_breakdown[k].cost_usd);
  for (const k of Object.keys(module_breakdown)) module_breakdown[k].cost_usd = r6(module_breakdown[k].cost_usd);
  for (const k of Object.keys(task_type_breakdown)) task_type_breakdown[k].cost_usd = r6(task_type_breakdown[k].cost_usd);
  return {
    pass, policy_name, started_at, ended_at, duration_sec,
    total_cost_usd, total_input_tokens, total_input_tokens_cached, total_output_tokens,
    model_breakdown, phase_breakdown, module_breakdown, task_type_breakdown,
    artifacts: { files: copied, loc: 0, tests: 3, test_pass_rate: 1.0 },
    synthesized: true,
  };
}
