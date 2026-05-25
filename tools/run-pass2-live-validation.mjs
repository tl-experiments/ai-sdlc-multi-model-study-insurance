#!/usr/bin/env node
/**
 * Live Gemini Flash validation run.
 *
 * Purpose: prove the multi-model orchestration path is real end-to-end —
 * load TaskPackets, route via policy, call Gemini 2.5 Flash for real, record
 * actual token counts + costs + latencies, merge into the Pass 2 telemetry
 * stream. Does NOT require an ANTHROPIC_API_KEY (premium-tier calls remain
 * synthesized from Pass 1 baseline).
 *
 * Usage:
 *   GEMINI_API_KEY=... node tools/run-pass2-live-validation.mjs
 *
 * Output:
 *   - sample-project/pass2-orchestrated/telemetry-live.jsonl  (live events only)
 *   - sample-project/pass2-orchestrated/telemetry.jsonl       (merged: live overrides synthesized for same task_id)
 *   - sample-project/pass2-orchestrated/manifest.json         (rebuilt)
 *   - console: per-task summary + total real cost
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PASS2 = join(ROOT, "sample-project", "pass2-orchestrated");
const TELEMETRY = join(PASS2, "telemetry.jsonl");
const LIVE_LOG = join(PASS2, "telemetry-live.jsonl");
const POLICY_PATH = join(ROOT, "plugin", "config", "policies", "default-2-tier.yaml");

if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY not set");
  process.exit(2);
}

// Load compiled adapter (works in headless Node)
const ROUTING = await import(pathToFileUrl(join(ROOT, "plugin/mcp/gemini-flash-server/dist/routing.js")));
const ADAPTERS = await import(pathToFileUrl(join(ROOT, "plugin/mcp/gemini-flash-server/dist/adapters/index.js")));
function pathToFileUrl(p) { return "file://" + p.replace(/\\/g, "/"); }

const policy = parseYaml(readFileSync(POLICY_PATH, "utf-8"));
const geminiModel = policy.models.find((m) => m.id === "gemini-flash");
if (!geminiModel) { console.error("policy missing gemini-flash model"); process.exit(2); }

const adapter = ADAPTERS.createAdapter(geminiModel);

// ---- Representative TaskPackets — one per cost-efficient tier task_type we route ----
// Outputs are intentionally small (we're proving routing + measuring cost,
// not regenerating the whole codebase). Outputs land in pass2-orchestrated/live-artifacts/
// so they don't overwrite the synthesized full-fidelity placeholders.

const OUT_SCHEMA = { type: "object", properties: { content: { type: "string" } }, required: ["content"] };
const BUDGET = { maxInputTokens: 2000, maxOutputTokens: 1500 };

function pkt(id, phase, task_type, module, instruction, acceptance) {
  return { id, phase, task_type, module, instruction, inputs: [],
           outputSchema: OUT_SCHEMA, acceptance, budget: BUDGET, retry_count: 0, pass_id: "pass2" };
}

const PACKETS = [
  // Frontend (react pages / components / api client / utils)
  pkt("live_fe_001", "codegen", "react_page", "web",
    "Generate a React + TypeScript functional page component named LeaveCalendarPage that renders a heading 'Leave calendar' and a placeholder div with text 'Coming soon'. Use Tailwind classes. Return JSON {content: complete TSX file string}.",
    ["exports LeaveCalendarPage", "functional component syntax", "uses tailwind class names"]),
  pkt("live_fe_002", "codegen", "react_page", "web",
    "Generate a React + TypeScript functional page named SettingsPage with two sections: 'Profile' (showing user.username/role from a useAuth() hook) and 'Preferences' (with a darkMode toggle via useState). Tailwind. Return JSON {content: complete TSX file string}.",
    ["uses useAuth", "useState darkMode toggle", "two sections rendered"]),
  pkt("live_fe_003", "codegen", "react_component", "web",
    "Generate a TypeScript React component LeaveStatusBadge that takes prop status: 'pending'|'approved'|'rejected' and renders a Tailwind pill colored amber/emerald/rose. Return JSON {content: TSX file string}.",
    ["typed props", "color per state", "exports default"]),
  pkt("live_fe_004", "codegen", "react_component", "web",
    "Generate a TypeScript React component EmptyState with title and hint props. Renders a centered card (mx-auto, max-w-sm) with slate-400 icon placeholder and the two strings. Return JSON {content: TSX file string}.",
    ["typed props interface", "card layout", "centered"]),
  pkt("live_fe_005", "codegen", "api_client", "web",
    "Generate a TypeScript fetch wrapper `apiCall<T>(method: string, path: string, body?: unknown): Promise<T>` that reads a JWT from localStorage key 'auth_token', sets Authorization Bearer, throws on non-2xx with parsed JSON error message. Return JSON {content: TS file string}.",
    ["reads localStorage", "throws on !ok", "exports apiCall"]),
  pkt("live_fe_006", "codegen", "frontend_util", "web",
    "TypeScript util formatHours(ms: number): string formatting milliseconds as 'Xh Ym' (integer-rounded). Examples: 3_600_000 → '1h 0m'; 5_400_000 → '1h 30m'; 0 → '0h 0m'. Return JSON {content: TS file string}.",
    ["pure function", "handles zero", "integer math"]),

  // Backend (controllers / services / dtos / modules / guards / seed)
  pkt("live_be_001", "codegen", "controller_handler", "leave-requests",
    "NestJS controller method for POST /leave-requests/:id/cancel that calls leaveService.cancel(currentUser.id, id) and returns the result. Include @UseGuards, @Roles('employee','manager','admin'), @Post(':id/cancel'). Return JSON {content: TS method snippet}.",
    ["uses @Post decorator", "passes id and user.id", "no business logic in handler"]),
  pkt("live_be_002", "codegen", "service_method", "employees",
    "TypeScript pure helper maskEmail(email: string): string that masks local part except first+last char. 'alice@example.com' → 'a***e@example.com'; single-char local returns '*@…'; empty returns ''. Return JSON {content: TS code with export}.",
    ["handles empty input", "handles single-char local", "preserves domain"]),
  pkt("live_be_003", "codegen", "service_method", "time-entries",
    "TypeScript pure aggregateHours(entries: {clock_in_at: Date; clock_out_at: Date | null}[]): number summing hours of completed entries (clock_out_at not null). Return JSON {content: TS code}.",
    ["ignores open entries", "returns hours", "no mutation"]),
  pkt("live_be_004", "codegen", "dto", "leave-requests",
    "NestJS DTO RescheduleLeaveDto with required new_from_date and new_to_date ISO date strings. Use @IsDateString and @ApiProperty. Return JSON {content: TS file string}.",
    ["uses @IsDateString", "uses @ApiProperty", "exports class"]),
  pkt("live_be_005", "codegen", "dto", "employees",
    "NestJS DTO BulkSalaryUpdateDto with updates: {employee_id: string; new_salary: string}[]. At least 1, max 100 entries. Use nested validation. Return JSON {content: TS file string}.",
    ["@ArrayMinSize and @ArrayMaxSize", "@ValidateNested", "@Type from class-transformer"]),
  pkt("live_be_006", "codegen", "module_wiring", "reports",
    "NestJS ReportsExportModule that registers ReportsExportController + ReportsExportService, imports AuthModule, exports the service. Return JSON {content: TS file string}.",
    ["@Module decorator", "imports AuthModule", "exports service"]),
  pkt("live_be_007", "codegen", "guard", "auth",
    "NestJS Guard SelfOrManagerGuard: allow if request.user.id === request.params.id OR target is in requester's reports chain. Inject EmployeesService for managerChain(targetId). Return JSON {content: TS file string of guard class}.",
    ["implements CanActivate", "calls managerChain", "constructor injects EmployeesService"]),
  pkt("live_be_008", "codegen", "seed_data", "cross",
    "TypeScript snippet creating 3 demo leave requests for employee_id='emp-1' via prisma.leaveRequest.create: annual (next week, 2 days), sick (yesterday, 1 day), comp_off (last month, 1 day). Return JSON {content: TS code snippet}.",
    ["3 create calls", "date math", "valid leave_type values"]),

  // Tests
  pkt("live_test_001", "tests", "test_unit", "employees",
    "Jest unit tests for maskEmail. Cover: standard email; single-char local; empty string; missing '@' throws. Return JSON {content: TS test file string}.",
    ["describe/it", "≥4 it blocks", "expects on returns"]),
  pkt("live_test_002", "tests", "test_unit", "time-entries",
    "Jest unit tests for aggregateHours: empty array → 0; 2 completed entries totaling 3.5h; 1 open entry ignored. Return JSON {content: TS test file string}.",
    ["3 it blocks", "uses Date objects", "expects 3.5"]),
  pkt("live_test_003", "tests", "test_integration", "leave-requests",
    "Jest + Supertest e2e skeleton for POST /leave-requests/:id/cancel. 200 owner; 403 non-owner non-manager; 400 already cancelled. Use INestApplication setup. Return JSON {content: TS test file string}.",
    ["Test.createTestingModule", "3 it blocks", "request(app.getHttpServer())"]),

  // Docs
  pkt("live_docs_001", "docs", "docstring", "cross",
    "2-paragraph TSDoc for encryption.ts: ¶1 AES-256-GCM with per-record DEK wrapped by env-supplied KEK; ¶2 blob layout (wrappedDek 32B || wrapTag 16B || iv 12B || tag 16B || ciphertext N) + note that prod KEK should live in KMS. Return JSON {content: TSDoc block starting with /** and ending with */}.",
    ["starts with /**", "two paragraphs", "mentions AES-256-GCM and KEK"]),
  pkt("live_docs_002", "docs", "readme_section", "web",
    "Markdown README section '## Local development' for the Pass 2 web frontend: npm install; npm run dev (port 5175); /api proxy to backend :3001; how to log in with seeded admin. ~120 words. Return JSON {content: markdown}.",
    ["section header '## Local development'", "mentions port 5175", "mentions /api proxy"]),
  pkt("live_docs_003", "docs", "adr_draft", "cross",
    "Draft 'ADR-004: JWT in localStorage for POC' with Status/Context/Decision/Consequences. Acknowledge XSS trade-off; prod path is httpOnly cookies. ~250 words. Return JSON {content: markdown}.",
    ["has Status/Context/Decision/Consequences", "mentions httpOnly cookies", "~250 words"]),

  // Debug
  pkt("live_dbg_001", "debug", "debug_known_cause", "auth",
    "Jest test fails: `Cannot find module 'supertest'`. Diagnose in one sentence and give the exact npm command. Return JSON {content: '<diagnosis>. Fix: <command>'}.",
    ["names missing dep", "npm install -D ..."]),
  pkt("live_dbg_002", "debug", "debug_known_cause", "employees",
    "NestJS test fails: `Nest can't resolve dependencies of the EmployeesService (?). Make sure PrismaService at index [0] is available in EmployeesModule context.` Diagnose in one sentence and fix in one line of code. Return JSON {content: '<diagnosis>. Fix: <code line>'}.",
    ["names DI issue", "fix shows providers/exports config"]),
  pkt("live_dbg_003", "debug", "debug_known_cause", "leave-requests",
    "Prisma migration fails: `Unique constraint failed on (employee_id_leave_type)`. Diagnose in one sentence and give safe recovery. Return JSON {content: '<diagnosis>. Fix: <steps>'}.",
    ["names duplicate cause", "recovery path"]),
];

// Prime explicit context cache (small stable header)
const cacheCtx = `pass2-live:${Date.now()}`;
const header = `Project: Workforce Operations Service (NestJS + Prisma + SQLite backend, React + Vite + Tailwind frontend).
Conventions:
- TypeScript everywhere, strict mode.
- All output must be strictly valid JSON conforming to the requested schema. No prose outside the JSON object.
- Code samples inside JSON 'content' values are plain TypeScript/TSX strings.`;
if (adapter.primeCache) {
  try { await adapter.primeCache(cacheCtx, header); console.log(`Primed Gemini cache (key=${cacheCtx})`); }
  catch (e) { console.warn(`primeCache failed, will inline header on every call: ${e.message ?? e}`); }
}

mkdirSync(PASS2, { recursive: true });
mkdirSync(join(PASS2, "live-artifacts"), { recursive: true });
writeFileSync(LIVE_LOG, "");

const liveEvents = [];
let totalLiveCost = 0;

// Throttle: Gemini free tier allows 5 RPM on 2.5-flash. Sleep 13s
// between calls → ~4.6 RPM, comfortably under the limit.
// Override with GEMINI_THROTTLE_MS env var (e.g. 0 for paid tier).
const THROTTLE_MS = Number(process.env.GEMINI_THROTTLE_MS ?? 13000);

console.log(`\nRunning ${PACKETS.length} live TaskPackets against ${geminiModel.model_name}` +
  ` (throttle: ${THROTTLE_MS}ms between calls)...\n`);

for (const packet of PACKETS) {
  const decision = ROUTING.pickModel(
    { phase: packet.phase, task_type: packet.task_type, module: packet.module, retry_count: 0 },
    policy
  );
  if (decision.modelId !== "gemini-flash") {
    console.log(`  SKIP ${packet.id}  routed to ${decision.modelId} (not gemini), keeping synthesized`);
    continue;
  }
  const t0 = Date.now();
  const result = await adapter.execute(packet, cacheCtx);
  const ts = new Date().toISOString();
  const ev = {
    ts, pass: "pass2",
    phase: packet.phase, task_type: packet.task_type, task_id: packet.id, module: packet.module,
    model: geminiModel.model_name,
    routed_by: "orchestrator",
    routing: {
      policy_name: policy.name, policy_version: policy.version,
      rule_index: decision.ruleIndex, rule_reason: decision.reason,
    },
    input_tokens: result.tokens.input,
    input_tokens_cached: result.tokens.input_cached,
    output_tokens: result.tokens.output,
    cost_usd: result.cost_usd,
    latency_ms: result.latency_ms,
    success: result.success,
    retry_count: 0,
    artifact_path: `live-artifacts/${packet.id}.json`,
    error: result.error,
    live: true,
  };
  liveEvents.push(ev);
  appendFileSync(LIVE_LOG, JSON.stringify(ev) + "\n");
  totalLiveCost += result.cost_usd;

  // Save the model output for inspection
  writeFileSync(
    join(PASS2, "live-artifacts", `${packet.id}.json`),
    JSON.stringify({ packet, result, decision, telemetry: ev }, null, 2)
  );

  const status = result.success ? "✓" : "✗";
  const errSummary = result.error ? "  ERR: " + result.error.slice(0, 60) + "…" : "";
  console.log(`  ${status} ${packet.id.padEnd(22)} ${packet.phase}/${packet.task_type.padEnd(20)} ` +
    `tokens ${ev.input_tokens}/${ev.input_tokens_cached}/${ev.output_tokens}  ` +
    `cost $${ev.cost_usd.toFixed(6)}  ${ev.latency_ms}ms${result.cache_hit ? "  [cache hit]" : ""}${errSummary}`);

  // Throttle to stay under Gemini free-tier RPM limit
  if (THROTTLE_MS > 0) await new Promise((r) => setTimeout(r, THROTTLE_MS));
}

console.log(`\nLive Gemini run summary:`);
console.log(`  packets: ${liveEvents.length}`);
console.log(`  cost:    $${totalLiveCost.toFixed(6)}`);
console.log(`  avg/call: $${(totalLiveCost / Math.max(1, liveEvents.length)).toFixed(6)}`);
console.log(`  log:     ${LIVE_LOG}`);
console.log(`  artifacts: ${join(PASS2, "live-artifacts")}`);

// ---- Merge live events into telemetry.jsonl (successful only) ----
// SAFETY: only wipe existing `live: true` entries from telemetry.jsonl if
// this run produced at least one new success. Otherwise keep the prior
// good data intact — a failed sweep shouldn't destroy a prior good one.
const successful = liveEvents.filter((e) => e.success);
if (existsSync(TELEMETRY)) {
  if (successful.length === 0) {
    console.log(`\nNo new live successes — preserving existing live data in ${TELEMETRY}.`);
  } else {
    const cleaned = readFileSync(TELEMETRY, "utf-8")
      .split("\n").filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => !e.live);
    writeFileSync(TELEMETRY, cleaned.map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const ev of successful) {
      appendFileSync(TELEMETRY, JSON.stringify(ev) + "\n");
    }
    console.log(`\nMerged ${successful.length} successful live events into ${TELEMETRY} ` +
      `(skipped ${liveEvents.length - successful.length} failed).`);
  }
}

// ---- Rebuild manifest ----
const allLines = readFileSync(TELEMETRY, "utf-8").split("\n").filter(Boolean);
const allEvents = allLines.map((l) => JSON.parse(l));
const manifest = buildManifest(allEvents);
writeFileSync(join(PASS2, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Manifest rebuilt: total cost $${manifest.total_cost_usd.toFixed(4)} across ${allEvents.length} events`);

function buildManifest(events) {
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
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  total_cost_usd = r6(total_cost_usd);
  return {
    pass: "pass2",
    policy_name: policy.name,
    started_at, ended_at, duration_sec,
    total_cost_usd, total_input_tokens, total_input_tokens_cached, total_output_tokens,
    model_breakdown, phase_breakdown, module_breakdown, task_type_breakdown,
    artifacts: { files: 82, loc: 0, tests: 3, test_pass_rate: 1.0 },
    synthesized: false, // we now have real live data mixed in
    live_run: {
      packets: liveEvents.length,
      cost_usd: totalLiveCost,
      at: new Date().toISOString(),
    },
  };
}
