export interface TelemetryEvent {
  ts: string;
  pass: string;                          // "pass1" | "pass2" | "pass3"
  phase: string;
  task_type: string;
  task_id: string;
  module: string;
  model: string;
  routed_by: string;
  routing: { policy_name: string; policy_version: number; rule_index: number; rule_reason: string };
  input_tokens: number;
  input_tokens_cached: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  retry_count: number;
  artifact_path?: string | null;
  error?: string;
  live?: boolean;
  synthesized?: boolean;
  // ───── Phase 2 forensic-grade per-event fields ─────
  round_trips?: number;                  // initial + every retry (defaults to retry_count + 1)
  artifact_loc?: number;                 // cloc-style LOC count of the resulting file
  artifact_sha256?: string;              // sha256 of the resulting file content
}

export interface Manifest {
  pass: string;
  pass_label?: string;
  policy_name: string;
  started_at: string;
  ended_at: string;
  duration_sec: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_input_tokens_cached: number;
  total_output_tokens: number;
  model_breakdown: Record<string, { calls: number; cost_usd: number; input_tokens: number; output_tokens: number }>;
  phase_breakdown: Record<string, { calls: number; cost_usd: number; models: string[] }>;
  module_breakdown: Record<string, { calls: number; cost_usd: number }>;
  task_type_breakdown: Record<string, { calls: number; cost_usd: number }>;
  artifacts?: { files: number; loc: number; tests: number; test_pass_rate: number; build_ok?: boolean; tests_passed?: number; tests_failed?: number; ts_errors?: number };
  quality_scores?: Record<string, number>;
  synthesized?: boolean;
  live_run?: { packets: number; cost_usd: number; at: string };
  regenerated_from_gemini?: { count: number; fail: number; attempted: number };
  // ───── Phase 2 forensic-grade fields (optional; populated by run-pass.mjs) ─────
  cache_hit_rate?: number;                                          // 0..1 — input_tokens_cached / input_tokens
  latency_ms_p50?: number;
  latency_ms_p95?: number;
  total_round_trips?: number;
  retry_distribution?: Record<string, number>;                      // {"0": n, "1": n, "2+": n}
  module_breakdown_by_model?: Record<string, Record<string, {     // module → model → tokens & cost
    calls: number;
    input_tokens: number;
    input_tokens_cached: number;
    output_tokens: number;
    cost_usd: number;
  }>>;
  reproducibility?: {
    git_tag?: string;
    git_sha?: string;
    brief_sha256?: string;
    design_sha256?: string;
    policy_sha256?: string;
    run_started_at?: string;
    model_ids?: Record<string, string>;                             // display_name → actual model_name
  };
}

export interface PolicyModel {
  id: string;
  adapter: string;
  model_name: string;
  display_name?: string;
  pricing: { input: number; input_cached: number; output: number };
  auth?: { env?: string };
}

export interface Policy {
  version: number;
  name: string;
  models: PolicyModel[];
  rules: Array<{ when?: any; use?: string; default?: string; reason?: string }>;
}

export interface PassConfig {
  id: string;
  label: string;
  shortLabel: string;
  directory: string;
  policy: string;
  apiPort?: number;
  webPort?: number;
  headerColor: string;
  description?: string;
}

export interface PassesConfig {
  passes: PassConfig[];
  model_substitutions?: Record<string, { actual_api_model: string; reason: string }>;
}

export interface PassData {
  config: PassConfig;
  events: TelemetryEvent[];
  manifest: Manifest;
}

// ───── Phase 2 multi-case-study additions ─────

export interface StudyConfig {
  id: string;
  label: string;
  shortLabel: string;
  phase: string;
  vertical: string;
  headerColor: string;
  description: string;
  directory: string;
  passes_root: string;
  baseline_cost_usd?: number;   // expected baseline-pass cost (USD); shown as a target before any pass runs
  passes: PassConfig[];
}

export interface StudiesConfig {
  studies: StudyConfig[];
  model_substitutions?: Record<string, { actual_api_model: string; reason: string }>;
}

export interface StudyData {
  config: StudyConfig;
  passes: PassData[];
  passById: Record<string, PassData>;
}
