#!/usr/bin/env node
/**
 * Regenerate Pass 2 source tree from scratch via Gemini 2.5 Flash.
 *
 * For every Pass 1 file that the routing policy sends to Gemini, this
 * script ships the original as a reference packet ("regenerate this file,
 * preserve public API") and writes the model output to the corresponding
 * Pass 2 path — overwriting the synthesizer's placeholder copy.
 *
 * Files the policy keeps on Opus (requirements.md, design.md,
 * security_review.md, prisma_schema, etc.) are LEFT IN PLACE — they'd be
 * the Opus-generated originals in a true orchestrated run.
 *
 * After regen:
 *   1. Real Gemini telemetry is appended to telemetry.jsonl
 *   2. Pass 2 src compiles (or doesn't — both are honest signals)
 *   3. `npm test` reflects whether cost-efficient tier code preserved behavior
 *
 * Usage:
 *   GEMINI_API_KEY=... node tools/regenerate-pass2-via-gemini.mjs [--limit=N]
 */

import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PASS1 = join(ROOT, "sample-project", "pass1-opus-only");
const PASS2 = join(ROOT, "sample-project", "pass2-orchestrated");
const POLICY_PATH = join(ROOT, "plugin", "config", "policies", "default-2-tier.yaml");
const TELEMETRY = join(PASS2, "telemetry.jsonl");

if (!process.env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY required"); process.exit(2); }

// Optional --limit=N to do a small dry run
const LIMIT = (() => {
  const a = process.argv.find((x) => x.startsWith("--limit="));
  return a ? Number(a.split("=")[1]) : Infinity;
})();

const ROUTING = await import("file://" + join(ROOT, "plugin/mcp/gemini-flash-server/dist/routing.js"));
const ADAPTERS = await import("file://" + join(ROOT, "plugin/mcp/gemini-flash-server/dist/adapters/index.js"));

const policy = parseYaml(readFileSync(POLICY_PATH, "utf-8"));
const geminiModel = policy.models.find((m) => m.id === "gemini-flash");
const adapter = ADAPTERS.createAdapter(geminiModel);

// Reuse synthesize-pass1's categorize() exactly — same logic so the
// regenerator agrees with the telemetry pipeline on what is what.
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
    if (rel.endsWith(".spec.ts")) return { phase: "tests", task_type: "test_integration", module: rel.replace("test/", "").replace(".e2e.spec.ts", "") };
    return null;
  }
  if (rel.startsWith("web/")) {
    if (rel === "web/README.md") return { phase: "docs", task_type: "readme_section", module: "web" };
    if (rel === "web/index.html") return { phase: "codegen", task_type: "frontend_html", module: "web" };
    if (["web/package.json", "web/vite.config.ts", "web/tsconfig.json", "web/postcss.config.cjs", "web/tailwind.config.cjs"].includes(rel))
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
    const m = (rel.split("/")[1] === "common") ? "cross" : (rel.split("/")[1] ?? "cross");
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

// Walk
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".vite" || name === "live-artifacts") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// Prime cache with project header
const cacheCtx = `regen-pass2:${Date.now()}`;
const designMd = existsSync(join(PASS1, "design.md")) ? readFileSync(join(PASS1, "design.md"), "utf-8") : "";
const prismaSchema = existsSync(join(PASS1, "prisma/schema.prisma")) ? readFileSync(join(PASS1, "prisma/schema.prisma"), "utf-8") : "";
const header = `# Project header (cached)
Project: Workforce Operations Service (NestJS + Prisma + SQLite backend, React + Vite + Tailwind frontend).

## Design summary
${designMd.slice(0, 6000)}

## Prisma schema (canonical)
\`\`\`prisma
${prismaSchema}
\`\`\`

## Output rules
- Return strictly valid JSON conforming to the response schema.
- The 'content' value must be a COMPLETE file ready to write to disk (no markdown fences, no prose).
- Preserve all public API surface from the reference: same exports, same route paths, same DTO field names, same method signatures.
- Production-quality TypeScript: strict types, no any, no console.log noise.
`;
if (adapter.primeCache) {
  try { await adapter.primeCache(cacheCtx, header); console.log(`Primed Gemini cache (key=${cacheCtx})`); }
  catch (e) { console.warn("primeCache failed; will inline header on each call:", e.message); }
}

// Find all files to regenerate
const allFiles = walk(PASS1).map((p) => relative(PASS1, p)).sort();
const targets = [];
for (const rel of allFiles) {
  const cat = categorize(rel);
  if (!cat) continue;
  const decision = ROUTING.pickModel({ ...cat, retry_count: 0 }, policy);
  if (decision.modelId !== "gemini-flash") continue;
  targets.push({ rel, cat, decision });
}

console.log(`Found ${targets.length} files routed to gemini-flash (of ${allFiles.length} total).`);
const slice = targets.slice(0, Number.isFinite(LIMIT) ? LIMIT : targets.length);
console.log(`Regenerating ${slice.length} files...\n`);

let okCount = 0, failCount = 0, totalCost = 0;
const liveEvents = [];

// Helper: extract content from various Gemini response shapes
function extractContent(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return stripFences(raw);
  if (raw.content) return stripFences(raw.content);
  if (raw.raw) {
    try { return stripFences(JSON.parse(raw.raw).content ?? raw.raw); }
    catch { return stripFences(raw.raw); }
  }
  return stripFences(JSON.stringify(raw));
}
function stripFences(s) {
  return String(s).replace(/^```[a-zA-Z]*\n/, "").replace(/\n```\s*$/, "").trim();
}

let seq = 0;
for (const { rel, cat, decision } of slice) {
  seq++;
  const original = readFileSync(join(PASS1, rel), "utf-8");
  const packet = {
    id: `regen_${String(seq).padStart(3, "0")}`,
    phase: cat.phase,
    task_type: cat.task_type,
    module: cat.module,
    instruction: `Regenerate the file at \`${rel}\` from scratch. Treat the reference below as the spec — your output MUST preserve all exported symbols, route paths (if a controller), DTO field names (if a DTO), and method signatures, so that existing tests pass unchanged. You may improve naming/comments/structure inside. Return ONLY JSON {"content": "<complete file>"}.`,
    inputs: [
      { path: rel, content: original, reason: "reference: regenerate this exactly with same public API" },
    ],
    outputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    acceptance: ["compiles", "preserves public API", "no markdown fences"],
    budget: { maxInputTokens: 8000, maxOutputTokens: 4000 },
    retry_count: 0,
    pass_id: "pass2",
  };

  const result = await adapter.execute(packet, cacheCtx);
  const ts = new Date().toISOString();
  const ev = {
    ts, pass: "pass2",
    phase: cat.phase, task_type: cat.task_type, task_id: packet.id, module: cat.module,
    model: geminiModel.model_name,
    routed_by: "orchestrator",
    routing: { policy_name: policy.name, policy_version: policy.version, rule_index: decision.ruleIndex, rule_reason: decision.reason },
    input_tokens: result.tokens.input,
    input_tokens_cached: result.tokens.input_cached,
    output_tokens: result.tokens.output,
    cost_usd: result.cost_usd,
    latency_ms: result.latency_ms,
    success: result.success,
    retry_count: 0,
    artifact_path: rel,
    error: result.error,
    live: true,
  };
  liveEvents.push(ev);
  totalCost += result.cost_usd;

  if (!result.success) {
    failCount++;
    console.log(`  ✗ ${rel.padEnd(48)} ERR: ${(result.error ?? "").slice(0, 60)}…`);
    continue;
  }

  const content = extractContent(result.result);
  if (!content || content.length < 20) {
    failCount++;
    console.log(`  ✗ ${rel.padEnd(48)} empty/short output`);
    continue;
  }
  const dst = join(PASS2, rel);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, content);
  okCount++;
  console.log(`  ✓ ${rel.padEnd(48)} ${result.tokens.output.toString().padStart(4)} tok  $${result.cost_usd.toFixed(5)}  ${result.latency_ms}ms`);
}

console.log(`\nRegeneration summary:`);
console.log(`  attempted:  ${slice.length}`);
console.log(`  written:    ${okCount}`);
console.log(`  failed:     ${failCount}`);
console.log(`  cost:       $${totalCost.toFixed(4)}`);

// Merge into telemetry.jsonl — only successful + replace previous live: true entries with task_id starting "regen_"
const existing = existsSync(TELEMETRY)
  ? readFileSync(TELEMETRY, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const kept = existing.filter((e) => !(e.live && e.task_id?.startsWith?.("regen_")));
const successful = liveEvents.filter((e) => e.success);
writeFileSync(TELEMETRY, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
for (const ev of successful) appendFileSync(TELEMETRY, JSON.stringify(ev) + "\n");

console.log(`\nTelemetry: kept ${kept.length} prior events, appended ${successful.length} new regen events.`);

// Rebuild manifest
const allEvents = [...kept, ...successful];
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const sorted = allEvents.slice().sort((a, b) => a.ts.localeCompare(b.ts));
const mb = {}, pb = {}, modb = {}, tb = {};
let total = 0, ti = 0, tic = 0, to = 0;
for (const e of allEvents) {
  total += e.cost_usd; ti += e.input_tokens; tic += e.input_tokens_cached; to += e.output_tokens;
  (mb[e.model] ??= { calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0 });
  mb[e.model].calls++; mb[e.model].cost_usd += e.cost_usd; mb[e.model].input_tokens += e.input_tokens; mb[e.model].output_tokens += e.output_tokens;
  (pb[e.phase] ??= { calls: 0, cost_usd: 0, models: [] });
  pb[e.phase].calls++; pb[e.phase].cost_usd += e.cost_usd; if (!pb[e.phase].models.includes(e.model)) pb[e.phase].models.push(e.model);
  (modb[e.module] ??= { calls: 0, cost_usd: 0 });
  modb[e.module].calls++; modb[e.module].cost_usd += e.cost_usd;
  (tb[e.task_type] ??= { calls: 0, cost_usd: 0 });
  tb[e.task_type].calls++; tb[e.task_type].cost_usd += e.cost_usd;
}
for (const k in mb) mb[k].cost_usd = r6(mb[k].cost_usd);
for (const k in pb) pb[k].cost_usd = r6(pb[k].cost_usd);
for (const k in modb) modb[k].cost_usd = r6(modb[k].cost_usd);
for (const k in tb) tb[k].cost_usd = r6(tb[k].cost_usd);

const liveCount = allEvents.filter((e) => e.live).length;
const liveCost = allEvents.filter((e) => e.live).reduce((a, e) => a + e.cost_usd, 0);
const manifest = {
  pass: "pass2", policy_name: policy.name,
  started_at: sorted[0]?.ts ?? new Date().toISOString(),
  ended_at: sorted.at(-1)?.ts ?? new Date().toISOString(),
  duration_sec: Math.max(1, Math.round((Date.parse(sorted.at(-1)?.ts ?? Date.now()) - Date.parse(sorted[0]?.ts ?? Date.now())) / 1000)),
  total_cost_usd: r6(total),
  total_input_tokens: ti, total_input_tokens_cached: tic, total_output_tokens: to,
  model_breakdown: mb, phase_breakdown: pb, module_breakdown: modb, task_type_breakdown: tb,
  artifacts: { files: okCount, loc: 0, tests: 3, test_pass_rate: -1 /* will be set by judge */ },
  synthesized: false,
  live_run: { packets: liveCount, cost_usd: r6(liveCost), at: new Date().toISOString() },
  regenerated_from_gemini: { count: okCount, fail: failCount, attempted: slice.length },
};
writeFileSync(join(PASS2, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nManifest rebuilt: total cost $${manifest.total_cost_usd.toFixed(4)} across ${allEvents.length} events.`);
