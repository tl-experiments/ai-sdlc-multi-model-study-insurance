#!/usr/bin/env node
/**
 * Author-from-scratch driver for a single pass of a single case study.
 *
 * Unlike Phase 1's regen.mjs (which uses a reference file), this driver
 * authors each file from scratch using brief.md + design.md + already-written
 * sibling files as context. The model is selected by the policy.
 *
 * Designed for the "shared-driving" pattern — user runs it with their
 * ANTHROPIC_API_KEY; I (Claude) authored the script and review outputs.
 *
 * Usage (env vars):
 *   ANTHROPIC_API_KEY=sk-... node tools/run-pass.mjs \
 *     --study=yotsuba-claims \
 *     --policy=opus-4-7 \
 *     [--limit=N]            (dry-run on the first N files)
 *     [--budget=USD]         (hard-stop if cumulative cost exceeds this)
 *     [--dry-run]            (prints planned TaskPackets, makes no API calls)
 *     [--resume]             (skip files that already exist in the target)
 *     [--start-at=<path>]    (skip until this file path; useful for resume after fixes)
 *     [--smoke]              (author ONE small file end-to-end into a .smoke-test/
 *                             subdir; ~$0.50, ~30s — validates API key, model
 *                             availability, adapter wiring, and JSON envelope
 *                             before committing to a multi-hour run)
 *
 * Outputs:
 *   case-studies/<study>/passes/<policy>/<file>           (the authored code)
 *   case-studies/<study>/passes/<policy>/telemetry.jsonl  (per-call events)
 *   case-studies/<study>/passes/<policy>/manifest.json    (rolled-up)
 */

import {
  readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, existsSync, appendFileSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ──────────────────── CLI ────────────────────
const arg = (k, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=").slice(1).join("=") : dflt;
};
const flag = (k) => process.argv.includes(`--${k}`);

const studyId = arg("study");
const policyName = arg("policy");
const limit = Number(arg("limit", Infinity));
const budgetUsd = Number(arg("budget", Infinity));
const startAt = arg("start-at");
const isDryRun = flag("dry-run");
const isResume = flag("resume");
const isSmoke  = flag("smoke");

if (!studyId || !policyName) {
  console.error("usage: run-pass.mjs --study=<id> --policy=<id> [--limit=N] [--budget=USD] [--dry-run] [--resume] [--start-at=<path>] [--smoke]");
  process.exit(2);
}
if (!isDryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required (set in .env or shell env)");
  process.exit(2);
}

// ──────────────────── config ────────────────────
const studies = JSON.parse(readFileSync(join(ROOT, "studies.json"), "utf-8"));
const study = studies.studies.find((s) => s.id === studyId);
if (!study) { console.error(`study '${studyId}' not in studies.json`); process.exit(2); }
const policyEntry = study.passes.find((p) => p.policy === policyName);
if (!policyEntry) { console.error(`policy '${policyName}' not in study '${studyId}'`); process.exit(2); }

const policyPath = join(ROOT, "plugin", "config", "policies", `${policyName}.yaml`);
if (!existsSync(policyPath)) { console.error(`policy file not found: ${policyPath}`); process.exit(2); }
const policy = parseYaml(readFileSync(policyPath, "utf-8"));

// Routing strategy:
//   - If the policy has multiple models AND non-default rules → ORCHESTRATED.
//     Every file is routed via pickModelForContext (uses the policy's rules).
//   - Otherwise → SINGLE-MODEL pass; use the policy's default model for every file.
function pickPrimaryModel() {
  const defaultRule = policy.rules.find((r) => "default" in r);
  const modelId = defaultRule?.default ?? policy.models[0]?.id;
  return policy.models.find((m) => m.id === modelId);
}
const isOrchestrated = policy.models.length > 1
  && policy.rules.some((r) => r.when && r.use);
const defaultModel = pickPrimaryModel();
if (!defaultModel) { console.error("policy has no model to author with"); process.exit(2); }
// Convenience alias for the single-model code paths below.
const model = defaultModel;

// For orchestrated runs, evaluate the policy's rules against a context object
// and return the matching model + the rule that fired (for telemetry).
function pickModelForContext(ctx) {
  for (let i = 0; i < policy.rules.length; i++) {
    const r = policy.rules[i];
    if ("default" in r) continue;
    const w = r.when ?? {};
    if (w.phase && w.phase !== ctx.phase) continue;
    if (w.task_type) {
      const arr = Array.isArray(w.task_type) ? w.task_type : [w.task_type];
      if (!arr.includes(ctx.task_type)) continue;
    }
    if (w.retry_count && typeof w.retry_count === "object" && "gte" in w.retry_count
        && (ctx.retry_count ?? 0) < w.retry_count.gte) continue;
    const m = policy.models.find((mm) => mm.id === r.use);
    if (m) return { model: m, rule_index: i, rule_reason: r.reason ?? "(no reason)" };
  }
  // Fallback: default model
  const dr = policy.rules.find((r) => "default" in r);
  const m = policy.models.find((mm) => mm.id === (dr?.default ?? policy.models[0]?.id));
  return { model: m, rule_index: -1, rule_reason: dr?.reason ?? "default" };
}

const STUDY_DIR = join(ROOT, study.directory);
// Smoke mode writes to an isolated subdir so it never contaminates a real pass.
const TARGET_DIR = isSmoke
  ? join(ROOT, study.passes_root, policyEntry.directory, ".smoke-test")
  : join(ROOT, study.passes_root, policyEntry.directory);
const TELEMETRY = join(TARGET_DIR, "telemetry.jsonl");

const briefContent = readFileSync(join(STUDY_DIR, "brief.md"), "utf-8");
const designContent = readFileSync(join(STUDY_DIR, "design.md"), "utf-8");

console.log(`\nAuthor-from-scratch driver`);
console.log(`  study:       ${study.label}`);
console.log(`  policy:      ${policy.name}  (${isOrchestrated ? "ORCHESTRATED, " + policy.models.length + " models" : "single-model"})`);
if (isOrchestrated) {
  for (const m of policy.models) {
    console.log(`    · ${m.id.padEnd(14)} → ${m.model_name}  (${m.display_name ?? m.model_name})`);
  }
} else {
  console.log(`  model:       ${model.model_name}  (label: ${model.display_name ?? model.model_name})`);
}
console.log(`  target dir:  ${study.passes_root}/${policyEntry.directory}`);
console.log(`  budget:      ${Number.isFinite(budgetUsd) ? `$${budgetUsd}` : "unlimited"}`);
console.log(`  dry-run:     ${isDryRun}`);
console.log(`  resume:      ${isResume}`);
console.log(`  smoke:       ${isSmoke}${isSmoke ? "  (isolated .smoke-test/ subdir, 1 file, ~$0.50)" : ""}\n`);

// ──────────────────── file list (study-specific) ────────────────────
// Ordered by dependency. Author shared/common files first; tests and docs last.
const FILE_LISTS = {
  "yotsuba-claims": [
    // root infra
    "package.json", "tsconfig.json", "nest-cli.json", "jest.config.cjs", "test/jest.setup.cjs",
    ".env.example", ".gitignore",
    // prisma
    "prisma/schema.prisma", "prisma/seed.ts",
    // common
    "src/common/encryption.ts",
    "src/common/jwt-auth.guard.ts", "src/common/roles.guard.ts",
    "src/common/roles.decorator.ts", "src/common/current-user.decorator.ts",
    "src/common/pii-mask.util.ts",
    "src/common/audit.decorator.ts", "src/common/audit.interceptor.ts",
    "src/common/error.filter.ts",
    "src/common/request-id.middleware.ts", "src/common/correlation-id.middleware.ts",
    // app shell
    "src/prisma.service.ts",
    // auth
    "src/auth/dto/login.dto.ts", "src/auth/auth.service.ts",
    "src/auth/auth.controller.ts", "src/auth/auth.module.ts",
    // audit
    "src/audit/audit.service.ts", "src/audit/audit.controller.ts", "src/audit/audit.module.ts",
    // claims
    "src/claims/dto/create-claim.dto.ts",
    "src/claims/dto/update-status.dto.ts",
    "src/claims/dto/assign-claim.dto.ts",
    "src/claims/dto/add-note.dto.ts",
    "src/claims/dto/add-evidence.dto.ts",
    "src/claims/dto/add-witness-statement.dto.ts",
    "src/claims/claims-status.fsm.ts",
    "src/claims/claims-channel.service.ts",
    "src/claims/claims.service.ts",
    "src/claims/claims.controller.ts",
    "src/claims/claims.module.ts",
    // reserves
    "src/reserves/dto/propose-reserve.dto.ts",
    "src/reserves/dto/reject-reserve.dto.ts",
    "src/reserves/reserves-jfsa.service.ts",
    "src/reserves/reserves-export.service.ts",
    "src/reserves/reserves.service.ts",
    "src/reserves/reserves.controller.ts",
    "src/reserves/reserves.module.ts",
    // appi
    "src/appi/dto/anonymise-request.dto.ts",
    "src/appi/appi.service.ts", "src/appi/appi.module.ts",
    // app
    "src/main.ts", "src/app.module.ts",
    // tests
    "test/auth.e2e.spec.ts", "test/claims-fnol.e2e.spec.ts",
    "test/claims-workbench.e2e.spec.ts", "test/reserves.e2e.spec.ts", "test/appi.e2e.spec.ts",
    // docs
    "README.md",
    "docs/ARCHITECTURE.md",
    "docs/adr/001-encryption.md", "docs/adr/002-audit-immutability.md",
    "docs/adr/003-role-masking-by-appi-tier.md", "docs/adr/004-claim-status-fsm.md",
    "docs/adr/005-reserve-approval-tiers.md", "docs/adr/006-jfsa-notification-pattern.md",
    // web — Adjuster Workbench
    "web/package.json", "web/tsconfig.json", "web/vite.config.ts",
    "web/tailwind.config.cjs", "web/postcss.config.cjs", "web/index.html",
    "web/src/main.tsx", "web/src/styles.css",
    "web/src/lib/format-yen.ts", "web/src/lib/api.ts", "web/src/lib/auth.tsx",
    "web/src/components/RoleBadge.tsx", "web/src/components/ClaimStatusPill.tsx",
    "web/src/components/SeverityPill.tsx", "web/src/components/EvidenceGallery.tsx",
    "web/src/components/Layout.tsx",
    "web/src/pages/Login.tsx", "web/src/pages/ClaimQueue.tsx",
    "web/src/pages/ClaimDetail.tsx", "web/src/pages/ReserveApprovals.tsx",
    "web/src/pages/AuditLog.tsx",
    "web/src/App.tsx",
  ],
};

const files = FILE_LISTS[studyId];
if (!files) { console.error(`no file list defined for study '${studyId}'`); process.exit(2); }

// ──────────────────── helpers ────────────────────
function categorize(rel) {
  if (rel === "README.md") return { phase: "docs", task_type: "readme_section", module: "cross" };
  if (rel === "docs/ARCHITECTURE.md") return { phase: "docs", task_type: "architecture_doc", module: "cross" };
  if (rel.startsWith("docs/adr/")) return { phase: "docs", task_type: "adr_draft", module: "cross" };
  if (rel === "prisma/schema.prisma") return { phase: "codegen", task_type: "prisma_schema", module: "cross" };
  if (rel === "prisma/seed.ts") return { phase: "codegen", task_type: "seed_data", module: "cross" };
  if (rel.startsWith("test/")) {
    if (rel.endsWith(".cjs")) return { phase: "codegen", task_type: "test_config", module: "cross" };
    return { phase: "tests", task_type: "test_integration", module: rel.replace("test/", "").replace(".e2e.spec.ts", "") };
  }
  if (rel.startsWith("web/")) {
    if (rel === "web/README.md") return { phase: "docs", task_type: "readme_section", module: "web" };
    if (rel === "web/index.html") return { phase: "codegen", task_type: "frontend_html", module: "web" };
    if (/web\/(package\.json|vite\.config\.ts|tsconfig\.json|postcss\.config\.cjs|tailwind\.config\.cjs)$/.test(rel))
      return { phase: "codegen", task_type: "frontend_config", module: "web" };
    if (rel.startsWith("web/src/pages/")) return { phase: "codegen", task_type: "react_page", module: "web" };
    if (rel.startsWith("web/src/components/")) return { phase: "codegen", task_type: "react_component", module: "web" };
    if (rel === "web/src/lib/api.ts") return { phase: "codegen", task_type: "api_client", module: "web" };
    if (rel === "web/src/lib/auth.tsx") return { phase: "codegen", task_type: "react_component", module: "web" };
    if (rel === "web/src/lib/format-yen.ts") return { phase: "codegen", task_type: "frontend_util", module: "web" };
    if (rel === "web/src/App.tsx" || rel === "web/src/main.tsx") return { phase: "codegen", task_type: "react_page", module: "web" };
    if (rel === "web/src/styles.css") return { phase: "codegen", task_type: "frontend_config", module: "web" };
    return { phase: "codegen", task_type: "frontend_other", module: "web" };
  }
  if (rel.startsWith("src/")) {
    const parts = rel.split("/");
    const m = parts[1] === "common" ? "cross"
            : parts[1] === "claims" ? "claims"
            : parts[1] === "reserves" ? "reserves"
            : parts[1] === "auth" ? "auth"
            : parts[1] === "audit" ? "audit"
            : parts[1] === "appi" ? "appi"
            : "cross";
    if (rel.endsWith(".controller.ts")) return { phase: "codegen", task_type: "controller_handler", module: m };
    if (rel.endsWith(".service.ts"))    return { phase: "codegen", task_type: "service_method",     module: m };
    if (rel.endsWith(".module.ts"))     return { phase: "codegen", task_type: "module_wiring",      module: m };
    if (rel.includes("/dto/"))          return { phase: "codegen", task_type: "dto",                module: m };
    if (rel.endsWith(".guard.ts"))      return { phase: "codegen", task_type: "guard",              module: "auth" };
    if (rel.endsWith(".interceptor.ts")) return { phase: "codegen", task_type: "interceptor",       module: m };
    if (rel.endsWith(".filter.ts"))     return { phase: "codegen", task_type: "filter",             module: "cross" };
    if (rel.endsWith(".middleware.ts")) return { phase: "codegen", task_type: "middleware",         module: "cross" };
    if (rel.endsWith(".decorator.ts"))  return { phase: "codegen", task_type: "decorator",          module: m };
    if (rel.endsWith(".fsm.ts"))        return { phase: "codegen", task_type: "fsm",                module: m };
    if (rel.endsWith("main.ts"))        return { phase: "codegen", task_type: "bootstrap",          module: "cross" };
    if (rel.endsWith("app.module.ts"))  return { phase: "codegen", task_type: "module_wiring",      module: "cross" };
    return { phase: "codegen", task_type: "service_method", module: m };
  }
  // root configs
  if (rel === "package.json" || rel === "tsconfig.json" || rel === "nest-cli.json" ||
      rel === "jest.config.cjs" || rel === ".env.example" || rel === ".gitignore") {
    return { phase: "codegen", task_type: "project_config", module: "cross" };
  }
  return { phase: "codegen", task_type: "other", module: "cross" };
}

// Which sibling files to include as in-context examples for the model — keep
// short, take the most recently authored ~3 from the same module (helps the
// model match conventions without bloating input tokens).
function pickContextFiles(rel, written) {
  const cat = categorize(rel);
  const sameModule = written.filter((w) => categorize(w.rel).module === cat.module).slice(-3);
  if (sameModule.length >= 2) return sameModule;
  return written.slice(-3);
}

// LOC counter (cloc-light): non-blank, non-comment-only lines.
function countLoc(content) {
  return content.split("\n").filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/")) return false;
    return true;
  }).length;
}

function sha256(s) { return createHash("sha256").update(s).digest("hex"); }

function stripFences(s) {
  if (typeof s !== "string") return s;
  return s.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```\s*$/, "").trim();
}

// Robust content extractor. Models hand back a variety of shapes:
//   (a) raw JSON object {"content": "..."}                   (Opus/Sonnet)
//   (b) markdown-fenced JSON ```json\n{"content":"..."}\n``` (Haiku)
//   (c) double-wrapped (the model put a JSON-envelope INSIDE the content
//       field — observed with Haiku on schema-driven tasks)
//   (d) raw file content with no envelope at all              (sometimes Haiku)
// We try each in order; the first that yields a non-trivial string wins.
function extractContent(raw) {
  if (raw == null) return "";

  // (1) Already-parsed object from adapter
  if (typeof raw === "object" && raw !== null) {
    if (typeof raw.content === "string") return unwrap(raw.content);
    if (typeof raw.raw === "string")     return unwrap(raw.raw);
    return stripFences(JSON.stringify(raw));
  }

  // (2) Raw string
  if (typeof raw === "string") return unwrap(raw);
  return stripFences(String(raw));
}

// Peel layers of JSON envelope + markdown fences off a string until the
// inner content stabilizes. Caps depth at 3 to avoid pathological loops.
function unwrap(s) {
  let cur = stripFences(s).trim();
  for (let depth = 0; depth < 3; depth++) {
    if (cur.startsWith("{") && cur.includes('"content"')) {
      try {
        const obj = JSON.parse(cur);
        if (obj && typeof obj.content === "string") {
          cur = stripFences(obj.content).trim();
          continue;
        }
      } catch {
        // Fall through to regex-based extraction below
      }
      // Regex fallback for JSON-shaped-but-not-quite-valid output (e.g. literal
      // newlines inside the string value). Grabs the value of the first
      // "content" key and JSON-unescapes common escapes.
      const m = cur.match(/^\s*\{\s*"content"\s*:\s*"([\s\S]*)"\s*\}\s*$/);
      if (m) {
        cur = m[1]
          .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
          .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        continue;
      }
    }
    break;
  }
  return cur;
}

// ──────────────────── adapter cache (lazy, per-model) ────────────────────
// For single-model passes there's one entry. For orchestrated passes,
// every model in the policy gets its own adapter so we don't repeatedly
// reconstruct the Anthropic / Gemini SDK clients per call.
const adapters = new Map();
let ADAPTER_MODULE = null;
async function getAdapter(forModel = model) {
  if (isDryRun) return null;
  if (adapters.has(forModel.id)) return adapters.get(forModel.id);
  if (!ADAPTER_MODULE) {
    ADAPTER_MODULE = await import(`file://${join(ROOT, "plugin/mcp/gemini-flash-server/dist/adapters/index.js")}`);
  }
  const a = ADAPTER_MODULE.createAdapter(forModel);
  // Prime the system cache with brief + design (Anthropic caches it as ephemeral block)
  const systemHeader = `You are authoring a single file at a time for a P&C insurance claims processing platform. Below is the locked product brief and architectural design. Your output MUST conform to design.md exactly — same exports, same Prisma schema fields, same route paths, same module boundaries.

═══ BRIEF (brief.md) ═══
${briefContent}

═══ DESIGN (design.md) ═══
${designContent}

═══ AUTHORING CONVENTIONS ═══
- Production-quality TypeScript, strict mode, no \`any\` without justification.
- All imports resolved; no placeholder \`TODO\` or \`unimplemented\`.
- Match exact file path requested. Output ONLY a JSON object with a single \`content\` key whose value is the COMPLETE file contents as a string.
- No prose, no markdown fences, no explanation outside the JSON object.
- For code files: emit valid syntax that compiles under tsconfig strict.
- For Prisma schema: emit the exact model definitions from design.md §1.
- For tests: import from \`../src/...\`, use Jest + Supertest patterns. Tests must actually run against a Postgres test DB.
`;
  if (typeof a.setSystemCache === "function") a.setSystemCache(systemHeader);
  adapters.set(forModel.id, a);
  return a;
}

// ──────────────────── run ────────────────────
mkdirSync(TARGET_DIR, { recursive: true });
if (!isResume) {
  // fresh start
  writeFileSync(TELEMETRY, "");
} else if (!existsSync(TELEMETRY)) {
  writeFileSync(TELEMETRY, "");
}

const events = [];
const written = [];      // [{rel, content}]
let cumulativeCost = 0;
let totalLoc = 0;
let okCount = 0, failCount = 0, skipCount = 0;

// Smoke mode: pick exactly one small, schema-driven file. tsconfig.json is
// ideal — short (~30 LOC), deterministic, exercises the full JSON-envelope +
// extractContent + write-to-disk pipeline.
const SMOKE_FILE = "tsconfig.json";
const slice = isSmoke
  ? [SMOKE_FILE]
  : files.slice(0, Number.isFinite(limit) ? limit : files.length);
let seq = 0, started = !startAt;

for (const rel of slice) {
  seq++;
  if (!started) {
    if (rel === startAt) started = true;
    else { skipCount++; continue; }
  }
  const cat = categorize(rel);
  const dst = join(TARGET_DIR, rel);

  // Resume support: skip if file exists + has content
  if (isResume && existsSync(dst) && statSync(dst).size > 0) {
    const content = readFileSync(dst, "utf-8");
    written.push({ rel, content });
    skipCount++;
    console.log(`  ⤵ skip   ${rel.padEnd(50)} (already written)`);
    continue;
  }

  // Budget check
  if (cumulativeCost >= budgetUsd) {
    console.log(`\n  ✋ budget reached ($${cumulativeCost.toFixed(4)} / $${budgetUsd}); stopping after ${okCount} files`);
    break;
  }

  const ctxFiles = pickContextFiles(rel, written);
  const packet = {
    id: `${policyName}_${String(seq).padStart(3, "0")}`,
    phase: cat.phase,
    task_type: cat.task_type,
    module: cat.module,
    instruction: `Author the file at \`${rel}\` from scratch. Follow the locked brief.md + design.md exactly (those are in the system prompt). Match conventions from the already-written files below.

Return ONLY a JSON object: \`{"content": "<the complete file as a string>"}\`. No markdown fences, no prose, no commentary outside the JSON.`,
    inputs: ctxFiles.length > 0 ? ctxFiles.map((w) => ({
      path: w.rel,
      content: w.content,
      reason: `already-written sibling — match its conventions`,
    })) : [],
    outputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    acceptance: ["matches design.md", "production-quality TS", "no placeholders"],
    // 8k output is roughly 400-600 LOC of dense TypeScript — comfortably covers
    // every file in the Yotsuba file list (the largest are seed.ts and the
    // Prisma schema at ~200 LOC). 4k was too tight and got truncated silently.
    budget: { maxInputTokens: 20000, maxOutputTokens: 8000 },
    retry_count: 0,
    pass_id: policyName,
  };

  // Route this file's TaskPacket against the policy rules. For single-model
  // passes this always picks the default; for orchestrated passes it routes
  // by phase + task_type per the policy YAML.
  const routed = isOrchestrated
    ? pickModelForContext({ phase: cat.phase, task_type: cat.task_type, module: cat.module, retry_count: 0 })
    : { model: defaultModel, rule_index: -1, rule_reason: `single-model pass (${policy.name})` };
  const callModel = routed.model;

  if (isDryRun) {
    console.log(`  · dry  ${rel.padEnd(50)} ${cat.phase}/${cat.task_type}/${cat.module}  →  ${callModel.display_name ?? callModel.model_name}  inputs=${ctxFiles.length}`);
    continue;
  }

  const adapter = await getAdapter(callModel);
  const result = await adapter.execute(packet);
  const ts = new Date().toISOString();

  let content = "";
  let success = result.success;
  if (success) {
    content = extractContent(result.result);
    if (!content || content.length < 5) success = false;
  }

  // Heuristic: output-token count near the requested ceiling almost
  // always means the response was truncated. Treat that as a failure
  // even if the adapter reported success.
  const outputCeiling = packet.budget.maxOutputTokens;
  const likelyTruncated = (result.tokens.output ?? 0) >= outputCeiling - 50;
  if (success && likelyTruncated) {
    success = false;
    console.log(`  ⚠  ${rel}  likely truncated (${result.tokens.output}/${outputCeiling} output tokens — retrying)`);
  }

  // Retry once on any failure with 2× output budget. Captures both
  //   - hard adapter failures (4xx, 5xx, JSON parse errors)
  //   - silent truncations (output hit the ceiling)
  //   - empty/short output (envelope leak that extractContent couldn't recover)
  let retryCount = 0;
  if (!success) {
    retryCount = 1;
    const oldCeiling = packet.budget.maxOutputTokens;
    packet.budget.maxOutputTokens = Math.min(32000, oldCeiling * 2);
    console.log(`  ↻ retry ${rel}  (output ceiling ${oldCeiling} → ${packet.budget.maxOutputTokens})`);
    const r2 = await (await getAdapter(callModel)).execute(packet);
    if (r2.success) {
      content = extractContent(r2.result);
      const r2Truncated = (r2.tokens.output ?? 0) >= packet.budget.maxOutputTokens - 50;
      success = !!content && content.length >= 5 && !r2Truncated;
      // merge tokens/cost for accounting
      result.tokens.input += r2.tokens.input;
      result.tokens.input_cached += r2.tokens.input_cached;
      result.tokens.output += r2.tokens.output;
      result.cost_usd += r2.cost_usd;
      result.latency_ms += r2.latency_ms;
    }
  }

  const loc = success ? countLoc(content) : 0;
  const ev = {
    ts, pass: policyName,
    phase: cat.phase, task_type: cat.task_type, task_id: packet.id, module: cat.module,
    model: callModel.model_name,
    model_display: callModel.display_name ?? callModel.model_name,
    routed_by: "orchestrator",
    routing: { policy_name: policy.name, policy_version: policy.version, rule_index: routed.rule_index, rule_reason: routed.rule_reason },
    input_tokens: result.tokens.input,
    input_tokens_cached: result.tokens.input_cached,
    output_tokens: result.tokens.output,
    cost_usd: result.cost_usd,
    latency_ms: result.latency_ms,
    success,
    retry_count: retryCount,
    round_trips: 1 + retryCount,
    artifact_path: rel,
    artifact_loc: loc,
    artifact_sha256: success ? sha256(content) : null,
    error: success ? undefined : (result.error ?? "empty/short output"),
    live: true,
  };
  events.push(ev);
  appendFileSync(TELEMETRY, JSON.stringify(ev) + "\n");
  cumulativeCost += result.cost_usd;

  if (success) {
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, content);
    written.push({ rel, content });
    totalLoc += loc;
    okCount++;
    // Cache hit rate = cached / (fresh + cached). `result.tokens.input` is
    // already the FRESH-only count (matches the new pricing.ts convention).
    const totalInput = result.tokens.input + result.tokens.input_cached;
    const cacheRatio = totalInput > 0 ? (result.tokens.input_cached / totalInput) : 0;
    const modelTag = isOrchestrated ? `  [${(callModel.display_name ?? callModel.model_name).split("-").slice(-1)[0].slice(0, 7)}]` : "";
    console.log(`  ✓ ${rel.padEnd(50)} ${result.tokens.output.toString().padStart(4)}tok  ${loc.toString().padStart(4)}loc  $${result.cost_usd.toFixed(5)}  ${result.latency_ms}ms  cache=${(cacheRatio * 100).toFixed(0)}%${retryCount ? `  [retry×${retryCount}]` : ""}${modelTag}`);
  } else {
    failCount++;
    console.log(`  ✗ ${rel.padEnd(50)} FAIL: ${(ev.error ?? "").slice(0, 60)}…`);
  }
}

// ──────────────────── manifest ────────────────────
const r6 = (n) => Math.round(n * 1e6) / 1e6;
function rollup(events) {
  const sorted = events.slice().sort((a, b) => a.ts.localeCompare(b.ts));
  const started_at = sorted[0]?.ts ?? new Date().toISOString();
  const ended_at = sorted.at(-1)?.ts ?? started_at;
  const duration_sec = Math.max(1, Math.round((Date.parse(ended_at) - Date.parse(started_at)) / 1000));

  const model_breakdown = {}, phase_breakdown = {}, module_breakdown = {}, task_type_breakdown = {};
  let total = 0, ti = 0, tic = 0, to = 0, total_round_trips = 0;
  for (const e of events) {
    total += e.cost_usd; ti += e.input_tokens; tic += e.input_tokens_cached; to += e.output_tokens;
    total_round_trips += e.round_trips ?? 1;

    const mb = (model_breakdown[e.model] ??= { calls: 0, cost_usd: 0, input_tokens: 0, input_tokens_cached: 0, output_tokens: 0, loc: 0 });
    mb.calls++; mb.cost_usd += e.cost_usd; mb.input_tokens += e.input_tokens; mb.input_tokens_cached += e.input_tokens_cached; mb.output_tokens += e.output_tokens; mb.loc += e.artifact_loc ?? 0;

    const pb = (phase_breakdown[e.phase] ??= { calls: 0, cost_usd: 0, models: [], by_model: {} });
    pb.calls++; pb.cost_usd += e.cost_usd; if (!pb.models.includes(e.model)) pb.models.push(e.model);
    const pbm = (pb.by_model[e.model] ??= { calls: 0, cost_usd: 0, input_tokens: 0, input_tokens_cached: 0, output_tokens: 0 });
    pbm.calls++; pbm.cost_usd += e.cost_usd; pbm.input_tokens += e.input_tokens; pbm.input_tokens_cached += e.input_tokens_cached; pbm.output_tokens += e.output_tokens;

    const mod = (module_breakdown[e.module] ??= { calls: 0, cost_usd: 0, loc: 0, by_model: {} });
    mod.calls++; mod.cost_usd += e.cost_usd; mod.loc += e.artifact_loc ?? 0;
    const modm = (mod.by_model[e.model] ??= { calls: 0, cost_usd: 0, input_tokens: 0, input_tokens_cached: 0, output_tokens: 0 });
    modm.calls++; modm.cost_usd += e.cost_usd; modm.input_tokens += e.input_tokens; modm.input_tokens_cached += e.input_tokens_cached; modm.output_tokens += e.output_tokens;

    const tb = (task_type_breakdown[e.task_type] ??= { calls: 0, cost_usd: 0 });
    tb.calls++; tb.cost_usd += e.cost_usd;
  }
  // round
  const round = (o) => { for (const k of Object.keys(o)) { if (typeof o[k] === "number") o[k] = r6(o[k]); else if (typeof o[k] === "object" && o[k]) round(o[k]); } };
  round(model_breakdown); round(phase_breakdown); round(module_breakdown); round(task_type_breakdown);

  // cached / (fresh + cached) — caps at 1.0 with effective caching.
  const cache_hit_rate = (ti + tic) > 0 ? r6(tic / (ti + tic)) : 0;
  const latencies = events.map((e) => e.latency_ms).sort((a, b) => a - b);
  const p = (q) => latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))];

  return {
    pass: policyName, pass_label: policyEntry.label, policy_name: policy.name,
    study: studyId,
    started_at, ended_at, duration_sec,
    total_cost_usd: r6(total),
    total_input_tokens: ti, total_input_tokens_cached: tic, total_output_tokens: to,
    cache_hit_rate, total_round_trips,
    latency_ms_p50: p(0.5), latency_ms_p95: p(0.95),
    model_breakdown, phase_breakdown, module_breakdown, task_type_breakdown,
    artifacts: {
      // Derive from the FULL telemetry stream (handles --resume correctly).
      // okCount + totalLoc are process-local counters and exclude previously-
      // written files when running in resume mode.
      files: events.filter((e) => e.success).length,
      loc: events.reduce((sum, e) => sum + (e.artifact_loc ?? 0), 0),
      tests: events.filter((e) => e.phase === "tests" && e.success).length,
      test_pass_rate: -1,                       // set by verifier
    },
    synthesized: false,
    reproducibility: {
      brief_sha256: sha256(briefContent),
      design_sha256: sha256(designContent),
      policy_sha256: sha256(readFileSync(policyPath, "utf-8")),
      authored_at: new Date().toISOString(),
      model_actual: model.model_name,
      model_requested: model.display_name ?? model.model_name,
    },
  };
}

if (!isDryRun) {
  // Merge with existing telemetry for resume case
  const allLines = existsSync(TELEMETRY) ? readFileSync(TELEMETRY, "utf-8").split("\n").filter(Boolean) : [];
  const allEvents = allLines.map((l) => JSON.parse(l));
  const manifest = rollup(allEvents);
  writeFileSync(join(TARGET_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (isSmoke) {
    // Smoke-mode summary is the actionable signal: did the full pipeline work
    // end-to-end with the configured model + key? On success, the operator
    // can confidently kick off the long run.
    const ok = okCount === 1 && failCount === 0;
    console.log(`\n${ok ? "✅" : "❌"} SMOKE TEST — ${policyName} / ${model.model_name}`);
    console.log(`  result:     ${ok ? "PASS" : "FAIL"}`);
    console.log(`  cost:       $${cumulativeCost.toFixed(5)}`);
    console.log(`  artifact:   ${TARGET_DIR}/${SMOKE_FILE}${ok ? "  (review it!)" : ""}`);
    console.log(`  telemetry:  ${TELEMETRY}`);
    if (ok) {
      console.log(`\n  ✓ API key, model_name '${model.model_name}', and pipeline are working.`);
      console.log(`  ✓ Safe to launch the full run:`);
      console.log(`      node tools/run-pass.mjs --study=${studyId} --policy=${policyName} --budget=<USD>\n`);
    } else {
      const ev = events[0];
      console.log(`\n  ✗ Failure detail:`);
      console.log(`      ${ev?.error ?? "(no event captured — check log above)"}\n`);
      console.log(`  Likely fixes:`);
      console.log(`    • If 404 not_found_error: edit plugin/config/policies/${policyName}.yaml`);
      console.log(`      → set model_name to an Opus model your account has access to.`);
      console.log(`    • If 401/403: rotate ANTHROPIC_API_KEY and re-source .env.`);
      console.log(`    • If empty/short output: extractContent may be failing on a JSON envelope — share the telemetry line.\n`);
    }
    process.exit(ok ? 0 : 1);
  }

  console.log(`\n${policyName} authoring complete:`);
  console.log(`  files written:    ${okCount}`);
  console.log(`  files skipped:    ${skipCount}`);
  console.log(`  files failed:     ${failCount}`);
  console.log(`  total cost:       $${cumulativeCost.toFixed(4)}`);
  console.log(`  total LOC:        ${totalLoc}`);
  console.log(`  manifest:         ${TARGET_DIR}/manifest.json`);
}
